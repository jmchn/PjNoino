'use strict'

const cluster = require('cluster')
const conf    = require('./_conf.json')
const db      = require('./db')
const http    = require('http')
const os      = require('os')
const routes  = require('./routes')
const util    = require('./util')

if (cluster.isMaster && !('dev' === process.env.environment)) { // to keep debugging simpler, do not fork in dev
    for (var i = 0; i < os.cpus().length; i++) cluster.fork()

    cluster.on('exit', function(worker, code, signal) {
        console.error(`worker pid ${worker.process.pid} died with code ${code} from signal ${signal}, replacing that worker`)
        cluster.fork()
    })
} else http.createServer(render).listen(conf.http_port)

async function render(req, res) {

    const start_time = Date.now()
    const ip      = req.headers['x-forwarded-for']
    const page    = util.segments(req.url)[1] || 'home'
    const context = { ip, page, req, start_time }

    try {
        if (!routes[req.method] || typeof routes[req.method][page] !== 'function') return bail(`404:${page} was not found`, res, context)

        context.cxn = await db.get_connection_from_pool(ip)

        if (!context.cxn)                                   return bail('429:failed to get cxn connection from pool', res, context)
        if (await blocked(context.cxn, context.ip))         return bail('403:user ip address blocked', res, context)
        if (await block_countries(context.cxn, context.ip)) return bail('403:country blocked', res, context)

        context.current_user = await get_user(context)
        context.header_data  = await get_header_data(context)
        context.admin_email  = await get_admin_email(context)

        var { code, headers, body } = await routes[req.method][page](context) // eg routes.GET.home
    }
    catch(e) {
        var code, body, matches
        if (e.message && (matches = e.message.match(/^(\d\d\d):(.*)/))) { // our own Error messages will all start with a response code and colon
            code = matches[1]
            body = matches[2]
        }
        else { // other kinds of errors won't have a response code in the string
            code = 500
            body = e.message || e.toString()
        }

        var headers = {
            'Content-Type' : 'text/html;charset=utf-8',
            'Expires'      : new Date().toUTCString()
        }

        console.error(`${Date()} ${context ? context.ip : ''} ${context ? context.req.headers.host + context.req.url : ''} failed with: ${body}`)
        console.error(e.stack)
    }

    db.release_connection_to_pool(context.cxn, context.ip)

    res.writeHead(code || 500, headers)
    res.end(body)
}

function bail(why, res, context) {
    db.release_connection_to_pool(context.cxn, context.ip)
    const [ code, explanation ] = why.split(':')
    res.writeHead(code || 500)
    res.end(explanation || 'unknown error')
}

async function get_user(context) { // update context with whether they are logged in or not

    try {
        var pairs = []

        context.req.headers.cookie.replace(/\s/g,'').split(';').forEach(function(element) {
            var name  = element.split('=')[0]
            var value = element.split('=')[1]
            pairs[name] = value
        })

        let current_user = await db.get_row('select * from users where user_id = ? and user_pass = ?',
            [pairs['patricknetuser'], pairs['patricknetpass']], context.cxn)

        if (current_user && current_user.user_id) {
            current_user = await set_relations(current_user, context)

            // update users currently online for display in header
            await db.query(`delete from onlines where online_last_view < date_sub(now(), interval 5 minute)`, null, context.cxn)
            await db.query(`insert into onlines (online_user_id, online_username, online_last_view) values (?, ?, now())
                         on duplicate key update online_last_view=now()`, [current_user.user_id, current_user.user_name], context.cxn)
        }

        return current_user
    }
    catch(e) { // no valid cookie
        if (context.req.headers['user-agent'] &&
            context.req.headers['user-agent'].match(/bot/m)) return null

        // user-agent does not have 'bot' in it, so count it as a lurker
        await db.query(`delete from lurkers where lurker_last_view < date_sub(now(), interval 5 minute)`, null, context.cxn)
        await db.query(`insert into lurkers (lurker_username, lurker_last_view) values (?, now()) on duplicate key update lurker_last_view=now()`,
                        [context.ip || 'null ip'], context.cxn)
        return null
    }
}

async function set_relations(current_user, context) { // update current_user with his relationships to other users
    // todo: eventually cache this data so we don't do the query on each hit
    if (!current_user) return

    let copy = JSON.parse(JSON.stringify(current_user)) // we never modify our parameters

    let non_trivial = `rel_my_friend > 0 or rel_i_ban > 0 or rel_i_follow > 0`
    let my_pov      = `select * from relationships left join users on users.user_id=relationships.rel_other_id where rel_self_id = ? and (${non_trivial})`
    let results     = await db.query(my_pov, [copy.user_id], context.cxn)

    copy.relationships = [] // now renumber results array using user_ids to make later access easy; sparse array so won't use extra memory

    for (var i = 0; i < results.length; ++i) copy.relationships[results[i].rel_other_id] = results[i] // index is the other user's user_id

    let other_pov   = `select * from relationships left join users on users.user_id=relationships.rel_other_id where rel_other_id = ? and (${non_trivial})`
        results     = await db.query(other_pov, [copy.user_id], context.cxn)

    copy.relationships_other = [] // array of how others see me; do they have me on ignore?
    for (var i = 0; i < results.length; ++i) copy.relationships_other[results[i].rel_self_id] = results[i] // index is the other user's user_id again

    return copy
}

async function get_header_data(context) { // data that the page header needs to render
    return {
        comments : await db.get_var(`select count(*) as c from comments`,           null, context.cxn), // int
        lurkers  : await db.get_var(`select count(*) from lurkers`,                 null, context.cxn), // int
        onlines  : await db.query(`select * from onlines order by online_username`, null, context.cxn), // obj
        tot      : await db.get_var(`select count(*) as c from users`,              null, context.cxn), // int
    }
}

async function get_admin_email(context) {
    return await db.get_var('select user_email from users where user_level=4 limit 1', [], context.cxn) // we assume there is just one user of level 4
}

function cached (fn) { // hat tip to vue.js; take a fn which takes (cxn, ip) and return a fn which takes the same parms, but caches results by ip
    var cache = Object.create(null)
    return async function (cxn, ip) {
        var hit = cache[ip]
        return hit || (cache[ip] = fn(cxn, ip))
    }
}

const block_countries = cached(async function (cxn, ip) { // block entire countries like Russia because all comments from there are inevitably spam
    return await db.get_var(`select country_evil from countries where
            country_start=(select max(country_start) from countries where country_start < inet_aton(?))
            and
            country_end=(select min(country_end) from countries where country_end > inet_aton(?))`, [ip, ip], cxn) ? true : false
})

const blocked = cached(async function (cxn, ip) { // was the ip nuked in the past?
    return (await db.get_var('select count(*) as c from nukes where nuke_ip = ?', [ip], cxn)) ? true : false
})

process.on('unhandledRejection', (reason, p) => { // very valuable for debugging unhandled promise rejections
    console.error(`unhandled rejection at promise ${p}; reason is ${reason}`)
    console.error(reason.stack)
})

process.on('uncaughtException', function (error) {
    console.error(error)
})
