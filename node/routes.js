'use strict'

const components  = require('./components')
const conf        = require('./_conf.json')    // _conf.json is required
const db          = require('./db')
const formidable  = require('formidable')      // via npm for image uploading
const fs          = require('fs')
const nodemailer  = require('nodemailer')      // via npm to send emails
const permissions = require('./permissions')
const querystring = require('querystring')
const url         = require('url')
const util        = require('./util')

const BASEURL = ('dev' === process.env.environment) ? `http://dev.${conf.domain}` : `https://${conf.domain}` // conf.baseurl_dev is for testing

Object.assign(global, components) // make all components global functions in this file

let routes  = {}
routes.GET  = {}
routes.POST = {}

exports = module.exports = routes

const MAXDIM = 800 // maximum width of an uploaded image

routes.GET.delete_newslink = async function(context) {
    if (!context.current_user | !(context.current_user.user_id === 1)) return send_html(200, 'permission_denied')
    const newslink_id = util.intval(util._GET(context.req.url, 'newslink_id'))
    await db.query('delete from newslinks where newslink_id = ?', [newslink_id], context.cxn)
    const newslinks = await db.query('select * from newslinks where newslink_pubdate is null', [], context.cxn)
    const content = newslink_list(newslinks, true)
    return send_html(200, content)
}

routes.GET.edit_newslinks = async function(context) {
    const newslinks = await db.query('select * from newslinks where newslink_pubdate is null', [], context.cxn)
    const content = newslink_list(newslinks, true)
    return send_html(200, content)
}

routes.GET.mail_newslinks = async function(context) {
    const n   = util.intval(util._GET(context.req.url, 'n')) || 20 // default to sending 20 emails at a time
    const key = util._GET(context.req.url, 'key')
    if (!key)            return die('key parameter missing', context)
    if (key.length != 8) return die('key format invalid', context)

    const allowed = await db.get_var('select count(*) from users where user_level=4 and substring(user_pass,1,8) = ?', [key], context.cxn)
    if (!allowed) return die('must be admin to mail newslinks', context)
    
    const newslinks = await db.query('select * from newslinks where newslink_pubdate = curdate()', [], context.cxn) // curdate() is utc time, bc db is utc

    if (!newslinks.length) {
        mail(context.admin_email,
             context.admin_email,
            'no newslinks for curdate',
            'mail_newslinks should not have been called without any links to send')
        return die('no newslinks for curdate', context)
    }

    const users =
        await db.query('select * from users where user_want_newsletter > 0 and (user_last_newsletter is null or user_last_newsletter <= now() - interval 1 day) limit ?',
            [n], context.cxn)

    if (!users.length) return die('no more users to mail', context)

    for (let i=0; i<users.length; i++) {
        const key = users[i].user_pass.substring(0, 8)

        if (key) { // send email only if user has a password
            const content = newslink_email(newslinks, users[i].user_id, key)

            mail(users[i].user_email,
                 context.admin_email,
                'Patrick.net Housing News',
                content)
        }
    }

    const ids_to_update = users.map(u => u.user_id)
    await db.query('update users set user_last_newsletter=now() where user_id in (?)', [ids_to_update], context.cxn)

    return send_html(200, `${users.length} mails sent`)
}

routes.GET.about = async function(context) {
    return redirect(`/post/${conf.about_post_id}`)
}

routes.POST.accept_comment = async function(context) { // insert new comment

    let post_data = await collect_post_data_and_trim(context)
    post_data.comment_browser_hash = context.req.headers['user-agent'] ? util.md5(context.req.headers['user-agent']) : null

    if (context.current_user && context.current_user.user_id) {
        post_data.comment_author = context.current_user.user_id
        post_data.comment_approved = context.current_user.user_level > 1 ? 1 : 0 // users > level 1 get their comments automatically approved
    }
    else { // comment-registration
        const result = await create_user(post_data.user_name, post_data.user_email, context.admin_email, context.cxn) // create the user
        if (!result.user_id) return send_json(200, { err: true, content: popup(result.message) })

        post_data.comment_author = result.user_id
        post_data.comment_approved = 0

        delete post_data.user_name  // delete these so we don't try to insert invalid fields in the 'insert into comments' below
        delete post_data.user_email
    }

    let result = await allow_comment(post_data, context)
    if (result.err) return send_json(200, result)

    post_data.comment_content = util.strip_tags(post_data.comment_content.linkify(), context.current_user)
    post_data.comment_date    = new Date().toISOString().slice(0, 19).replace('T', ' ') // mysql datetime format

    try {
        var insert_result = await db.query('insert into comments set ?', post_data, context.cxn)
        var comment_id = insert_result.insertId
    }
    catch(e) {
        console.error(`${e} at accept_comment`)
        return send_json(200, { err: false, content: popup(e.toString()) })
    }

    if (!context.current_user || !context.current_user.user_id) return send_json(200, { err: false, content: popup('Check your email to confirm your comment') })

    let comment = await db.get_row('select * from comments left join users on comment_author=user_id where comment_id = ?', [comment_id], context.cxn)
    await after_accept_comment(comment, context)

    const message = format_comment(comment, context, context.comments, util._GET(context.req.url, 'offset')) // if no message, then the comment itself
    return send_json(200, { err: false, content: message })
}

routes.POST.accept_edited_comment = async function(context) { // update old comment

    if (!util.valid_nonce(context)) return die(invalid_nonce_message(), context)

    let post_data = await collect_post_data_and_trim(context)

    if (!post_data.comment_content) return die('please go back and enter some content', context)

    // rate limit by user's ip address
    if (await too_fast(context.ip, context.cxn)) return send_json(200, { err: true, content: popup('You are posting comments too quickly') })

    post_data.comment_content  = util.strip_tags(post_data.comment_content.linkify(), context.current_user)
    post_data.comment_approved = 1

    let comment_id = post_data.comment_id
    if (comment_id) {
        const comment = await db.get_row('select * from comments where comment_id = ?', [comment_id], context.cxn)
        if (comment && permissions.may_delete_comment(comment, context.current_user)) { // edit permission same as delete permission
            await db.query('update comments set ? where comment_id = ? and (comment_author = ? or 1 = ?)',
                        [post_data, comment_id, context.current_user.user_id, context.current_user.user_id], context.cxn)
        }
    }

    // now select the inserted row so that we pick up the comment_post_id
    const comment = await db.get_row('select * from comments where comment_id = ?', [comment_id], context.cxn)
    const offset  = await cid2offset(comment.comment_post_id, comment_id, context)
    return redirect(`/post/${comment.comment_post_id}?offset=${offset}#comment-${comment_id}`)
}

routes.POST.accept_post = async function(context) { // insert new post or update old post

    if (!context.current_user) return die('anonymous posts are not allowed', context)

    let post_data = await collect_post_data_and_trim(context)

    if (!post_data.post_title) return die('please go back and enter a title for your post', context)

    post_data.post_content  = util.strip_tags(post_data.post_content.linkify(), context.current_user) // remove all but a small set of allowed html tags
    post_data.post_approved = 1 // may need to be more restrictive if spammers start getting through

    var p = util.intval(post_data.post_id)
    if (p) { // editing old post, do not update post_modified time because it confuses users
        const post = await get_post(p, context)
        if (post && permissions.may_delete_post(post, context.current_user)) await db.query('update posts set ? where post_id=?', [post_data, p], context.cxn)
    }
    else { // new post
        const duplicate = await db.get_var('select post_id from posts where post_title=?', [post_data.post_title], context.cxn)
        if (duplicate) return die(`That title has already been used, <a href='/post/${duplicate}' target='_blank' >here</a>`, context)

        post_data.post_author = context.current_user.user_id

        if (await hit_daily_post_limit(context)) return die('sorry, you hit your new post limit for today', context)

        try {
            var results = await db.query('insert into posts set ?, post_modified=now()', post_data, context.cxn)
            p = results.insertId
            if (!p) return die(`failed to insert ${post_data} into posts`, context)
            await update_user_post_count(context);
        }
        catch (e) { return die(e, context) }

        // insert first external link into newslinks table
        const extlinks = util.get_external_links(post_data.post_content, conf.domain)
        if (extlinks.length) {
            try {
                await db.query('insert into newslinks set newslink_url=?, newslink_title=?, newslink_post_id=?', [extlinks[0], post_data.post_title, p], context.cxn)
            }
            catch (e) {} // do not die on duplicate urls
        }

        await post_mail(p, context) // reasons to send out post emails: @user, user following post author
    }

    const post_row = await get_post(p, context)

    return redirect(util.post2path(post_row))
}

routes.GET.judge_comment = async function(context) {

    const comment_id = util.intval(util._GET(context.req.url, 'comment_id'))
    const flag       =             util._GET(context.req.url, 'flag').replace(/\W/, '')
    const flag_index = util.flags.indexOf(flag);

    if (-1 == flag_index)                    return send_html(200, '') // not a valid flag
    if (!comment_id)                         return send_html(200, '')
    if (!util.flags[flag_index])             return send_html(200, '')
    if (!util.valid_nonce(context))          return send_html(200, '')
    if (!context.current_user)               return send_html(200, '')
    if (context.current_user.user_level < 3) return send_html(200, '') // must be moderator or admin to approve comment

    await db.query('update comments set comment_approved=? where comment_id=?', [flag_index, comment_id], context.cxn)

    const post_id = await db.get_var('select comment_post_id from comments where comment_id=?', [comment_id], context.cxn)
    reset_latest_comment(post_id, context.cxn)

    return send_html(200, '') // make it disappear from comment_moderation page
}

routes.GET.approve_post = async function(context) {

    let post_id = util.intval(util._GET(context.req.url, 'post_id'))

    if (!post_id)                              return send_html(200, '')
    if (!context.current_user)                 return send_html(200, '')
    if (context.current_user.user_level !== 4) return send_html(200, '')
    if (!util.valid_nonce(context))            return send_html(200, '')

    await db.query('update posts set post_approved=1, post_modified=now() where post_id=?', [post_id], context.cxn)

    return send_html(200, '') // make it disappear from post_moderation page
}

routes.GET.autowatch = async function(context) {

    var current_user_id = context.current_user ? context.current_user.user_id : 0

    if (!current_user_id) return die('must be logged in to stop watching all posts', context)

    // left joins to also get each post's viewing and voting data for the current user if there is one
    let sql = `update postviews set postview_want_email=0 where postview_user_id = ?`
    await db.query(sql, [current_user_id], context.cxn)

    var content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                h1(`All email of new post comments turned off`)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.best = async function(context) {

    if ('true' === util._GET(context.req.url, 'all')) {
        var sql = `select * from comments left join users on user_id=comment_author where comment_likes > 3
                   order by comment_likes desc limit 40`

        var m = `<h2>best comments of all time</h2>or view the <a href='/best'>last week's</a> best comments<p>`
    }
    else {
        var sql = `select * from comments left join users on user_id=comment_author where comment_likes > 3
                   and comment_date > date_sub(now(), interval 7 day) order by comment_likes desc limit 40`

        var m = `<h2>best comments in the last week</h2>or view the <a href='/best?all=true'>all-time</a> best comments<p>`
    }

    let comments = await db.query(sql, [], context.cxn)

    let offset = 0
    comments = comments.map(comment => { comment.row_number = ++offset; return comment })

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                m,
                comment_list(comments, context)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.comment_moderation = async function(context) {

    const current_user = context.current_user

    if (!current_user)               return die('you must be logged in to moderate comments', context)
    if (current_user.user_level < 3) return die('you are not a moderator', context)

    let comments = await comments_to_moderate(context)

    let offset = 0
    comments = comments.map(comment => { comment.row_number = ++offset; return comment })

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                h1('comment moderation'),
                comment_list(comments, context)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.comments = async function(context) { // show a list of comments by user, or by comment-frequence, or from a search

    let offset  = util.intval(util._GET(context.req.url, 'offset'))
    let comments
    let message = ''

    if (util._GET(context.req.url, 'a')) {      // a is author name
        let a   = decodeURIComponent(util._GET(context.req.url, 'a').replace(/[^\w %]/, ''))
        let user = await get_user_by_name(a, context.cxn)
        if (!user) return die(`no such user: ${ a }`, context)
        comments = await get_comment_list_by_author(user, 40, context.cxn, context.req.url)
        message = `<h2>${a}'s comments</h2>`
    }
    else if (util._GET(context.req.url, 'n')) { // n is number of comments per author, so we can see all comments by one-comment authors, for example
        let n   = util.intval(util._GET(context.req.url, 'n'))
        comments = await get_comment_list_by_number(n, offset, 40, context.cxn)
        message = `<h2>comments by users with ${n} comments</h2>`
    }
    else if (util._GET(context.req.url, 's')) { // comment search
        let s   = util._GET(context.req.url, 's').replace(/[^\w %]/, '')
        comments = await get_comment_list_by_search(s, offset, 40, context.cxn)
        message = `<h2>comments that contain "${s}"</h2>`
    }
    else if (util._GET(context.req.url, 'r')) { // registration date
        if (!context.current_user || (!context.current_user.user_id == 1)) return send_html(200, `permission denied`)
        comments = await get_comment_list_by_registration(offset, 40, context.cxn)
        message = `<h2>comments by user_registration desc</h2>`
    }
    else return send_html(200, `invalid request`)

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                h1(message),
                comment_pagination(comments, context.req.url),
                comment_list(comments, context),
                comment_search_box()
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.delete_comment = async function(context) { // delete a comment

    const comment_id = util.intval(util._GET(context.req.url, 'comment_id'))
    const post_id    = util.intval(util._GET(context.req.url, 'post_id'))

    if (!(comment_id && post_id)) return send_html(200, '')
    if (!context.current_user)    return send_html(200, '')
    if (!util.valid_nonce(context))    return send_html(200, '')

    const comment        = await db.get_row('select * from comments left join users on comment_author=user_id where comment_id = ?', [comment_id], context.cxn)
    if (!comment) return send_html(200, '')

    const comment_author = comment.comment_author
    const user_id        = context.current_user.user_id

    if (!permissions.may_delete_comment(comment, context.current_user)) return send_html(200, '')

    await db.query(`delete from comments where comment_id = ?`, [comment_id, user_id, user_id, user_id], context.cxn)

    await db.query(`update users set user_comments=(select count(*) from comments where comment_author = ?) where user_id = ?`,
                [comment_author, comment_author], context.cxn)

    await reset_latest_comment(post_id, context.cxn)
    await penalize(comment_author, context)

    // notify admin if comment deleted by a moderator (a level 3 user)
    if (3 === context.current_user.user_level) {
        mail(context.admin_email, context.admin_email, `comment deleted by ${context.current_user.user_name}`, `${comment.user_name} said: ${comment.comment_content}`)
    }

    return send_html(200, '')
}

routes.GET.delete_post = async function(context) { // delete a whole post, but not its comments

    if (!context.current_user) return die('you must be logged in to delete a post', context)
    if (!util.valid_nonce(context)) return die(invalid_nonce_message(), context)

    var post_id
    if (post_id = util.intval(util._GET(context.req.url, 'post_id'))) {

        let post = await get_post(post_id, context)
        if (!post) return die('no such post', context)

        if (permissions.may_delete_post(post, context.current_user)) {
            let results = await db.query(`delete from posts where post_id = ?`, [post_id], context.cxn)
            await update_user_post_count(context);
            return die(`${results.affectedRows} post deleted`, context)
        }
        else return die('permission to delete post denied', context)
    }
    else return die('need a post_id', context)
}

routes.GET.dislike = async function(context) { // given a comment or post, downvote it

    if (!context.current_user) return send_html(200, '')

    const user_id   = context.current_user.user_id
    const user_name = context.current_user.user_name

    if (util.intval(util._GET(context.req.url, 'comment_id'))) {
        const content = await dislike_comment(user_id, context)
        return send_html(200, content)
    }
    else if (util.intval(util._GET(context.req.url, 'post_id'))) {
        const content = await dislike_post(user_id, context)
        return send_html(200, content)
    }
    else return send_html(200, '') // send empty string if no comment_id or post_id
}

routes.GET.edit_comment = async function (context) {

    if (!util.valid_nonce(context)) return die(invalid_nonce_message(), context)

    let comment_id = util.intval(util._GET(context.req.url, 'c'))
    let comment = await db.get_row(`select * from comments left join users on user_id=comment_author where comment_id=?`, [comment_id], context.cxn)

    if (!comment) return send_html(404, `No comment with id "${comment_id}"`)
    else {

        let content = html(
            head(conf, context),
            body(
                header(context),
                midpage(
                    comment_edit_box(comment, context)
                ),
                footer(context.admin_email),
            ),
            timings(context),
        )

        return send_html(200, content)
    }
}

routes.GET.edit_post = async function (context) {

    if (!util.valid_nonce(context)) return die(invalid_nonce_message(), context)

    let post_id = util.intval(util._GET(context.req.url, 'p'))
    let post = await db.get_row(`select * from posts left join users on user_id=post_author where post_id=?`, [post_id], context.cxn)

    if (!post) return send_html(404, `No post with id "${post_id}"`)
    else {

        let content = html(
            head(conf, context),
            body(
                header(context),
                midpage(
                    post_form(util._GET(context.req.url, 'p'), post)
                ),
                footer(context.admin_email),
            ),
            timings(context),
        )

        return send_html(200, content)
    }
}

routes.GET.edit_profile = async function(context) {

    if (!context.current_user) return die('please log in to edit your profile', context)

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                profile_form(util._GET(context.req.url, 'updated'), context)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.follow_user = async function(context) { // get or turn off emails of a user's new posts; can be called as ajax or full page

    let ajax     = util.intval(util._GET(context.req.url, 'ajax'))
    let other_id = util.intval(util._GET(context.req.url, 'other_id'))

    if (!other_id)                  return ajax ? send_html(200, '', context) : die('other_id missing')
    if (!context.current_user)      return ajax ? send_html(200, '', context) : die('must be logged in to follow or unfollow')
    if (!util.valid_nonce(context)) return ajax ? send_html(200, '', context) : die(invalid_nonce_message())

    if (util.intval(util._GET(context.req.url, 'undo'))) {
        await db.query(`replace into relationships set rel_i_follow=0, rel_self_id=?, rel_other_id=?`,
                    [context.current_user.user_id, other_id], context.cxn)
    }
    else {
        await db.query(`replace into relationships set rel_i_follow=unix_timestamp(now()), rel_self_ID=?, rel_other_id=?`,
                    [context.current_user.user_id, other_id], context.cxn)
    }

    // either way, output follow button with right context and update this user's follow count
    let u = await get_userrow(other_id, context.cxn)

    await db.query(`update users set user_followers=(select count(*) from relationships where rel_i_follow > 0 and rel_other_id=?)
                 where user_id=?`, [other_id, other_id], context.cxn)

    // mail the user who has just been followed
    mail(u.user_email,
        context.admin_email,
        `you have a new follower on ${conf.domain}`,
        `<a href='https://${conf.domain}/user/${context.current_user.user_name}'>${context.current_user.user_name}</a>
        is now following you on ${conf.domain} and will get emails of your new posts`)

    return ajax ? send_html(200, follow_user_button(u, context)) : die('Follow status updated')
}

routes.GET.home = async function(context) {

    var p

    if (p = util.intval(util._GET(context.req.url, 'p'))) return redirect(`/post/${p}`, 301) // legacy redirect for cases like /?p=1216301

    let current_user_id = context.current_user ? context.current_user.user_id : 0

    let [curpage, slimit, order, order_by] = util.which_page(util._GET(context.req.url, 'page'), util._GET(context.req.url, 'order'))

    // left joins to also get each post's viewing and voting data for the current user if there is one
    let sql = `select sql_calc_found_rows * from posts
               left join postviews on postview_post_id=post_id and postview_user_id= ?
               left join postvotes on postvote_post_id=post_id and postvote_user_id= ?
               left join users     on user_id=post_author where post_modified > date_sub(now(), interval 7 day) and post_approved=1
               ${order_by} limit ${slimit}`

    let posts = await db.query(sql, [current_user_id, current_user_id], context.cxn)

    let path = url.parse(context.req.url).pathname // "pathname" is url path without ? parms, unlike "path"

    let content = html(
        head(conf, context),
        body(
            header(context),
            (await comments_to_moderate(context)).length ? `Welcome moderator, there are <a href='/comment_moderation'>comments to moderate</a>` : '',
            midpage(
                tabs(order, '', path),
                post_list(posts, context),
                post_pagination(posts.found_rows, curpage, `&order=${order}`, context.req.url)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.ignore = async function(context) { // ignore a user

    let other_id = util.intval(util._GET(context.req.url, 'other_id'))

    if (!context.current_user) return send_html(200, '')
    if (!util.valid_nonce(context)) return send_html(200, '')

    // update this user's ignore count
    await db.query(`update users set user_bannedby=(select count(*) from relationships where rel_i_ban > 0 and rel_other_id=?)
                 where user_id=?`, [other_id, other_id], context.cxn)

    if (util.intval(util._GET(context.req.url, 'undo'))) {
        await db.query(`replace into relationships set rel_i_ban=0, rel_self_id=?, rel_other_id=?`,
                    [context.current_user.user_id, other_id], context.cxn)

        return send_html(200, '') // make the user disappear from edit_profile page
    }
    else {
        await db.query(`replace into relationships set rel_i_ban=unix_timestamp(now()), rel_self_ID=?, rel_other_ID=?`,
                    [context.current_user.user_id, other_id], context.cxn)

        return send_html(200, '')
    }
}

routes.GET.key_login = async function(context) {

    // if user is already logged in, redirect from key_login page to home page; otherwise logging in with key_login page redirects you to key_login page...
    if (context.current_user) return redirect('/')

    const key      = util._GET(context.req.url, 'key')
    const password = util.create_nonce(context.start_time).substring(0, 6)
    const email    = await db.get_var('select user_email from users where user_activation_key = ?', [key], context.cxn)

    if (email) { // erase key so it cannot be used again, and set new password
        await db.query('update users set user_activation_key=null, user_pass=? where user_activation_key=?', [util.md5(password), key], context.cxn)
        return await login(email, password, context)
    }
    else {
        const content = html(
            head(conf, context),
            body(
                header(context),
                midpage(
                    h1(`Darn, that key is unknown. Please try 'forgot password' if you need to log in.`)
                ),
                footer(context.admin_email),
            ),
            timings(context),
        )
        return send_html(200, content)
    }
}

routes.GET.like = async function(context) { // given a comment or post, upvote it

    if (!context.current_user) return send_html(200, '')

    const user_id   = context.current_user.user_id
    const user_name = context.current_user.user_name

    if (util.intval(util._GET(context.req.url, 'comment_id'))) {
        let content = await like_comment(user_id, user_name, context)
        await send_comment_like_email(user_name, context)
        return send_html(200, content)
    }
    else if (util.intval(util._GET(context.req.url, 'post_id'))) {
        let content = await like_post(user_id, context)
        await send_post_like_email(user_name, context)
        return send_html(200, content)
    }
    else return send_html(200, '') // send empty string if no comment_id or post_id
}

routes.GET.logout = async function(context) {

    var d = new Date()

    // you must use the undocumented "array" feature of res.writeHead to set multiple cookies, because json
    var headers = [
        ['Expires'        , d.toUTCString()                         ],
        ['Location'       , context.req.headers.referer             ],
        ['Set-Cookie'     , `patricknetpass=_; Expires=${d}; Path=/`],
        ['Set-Cookie'     , `patricknetuser=_; Expires=${d}; Path=/`],
    ] // do not use 'secure' parm with cookie or will be unable to test login in dev, bc dev is http only

   return({ code: 303, headers: headers, content: '' })
}

routes.GET.new_post = async function(context) {

    if (!permissions.may_create_post(context.current_user)) return die('permission to create new post denied', context)
    if (await hit_daily_post_limit(context))                return die('you hit your new post limit for today', context)

    var content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                post_form(util._GET(context.req.url, 'p'))
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.nuke = async function(context) { // given a user ID, nuke all his posts, comments, and his ID

    let nuke_id = util.intval(util._GET(context.req.url, 'nuke_id'))
    let u = await get_userrow(nuke_id, context.cxn)

    if (!util.valid_nonce(context))              return die(invalid_nonce_message(), context)
    if (1 !== context.current_user.user_id) return die('non-admin may not nuke', context)
    if (1 === nuke_id)                      return die('admin cannot nuke himself', context)

    let country = await ip2country(u.user_last_comment_ip, context.cxn)

    let rows = await db.query('select distinct comment_post_id from comments where comment_author=?', [nuke_id], context.cxn)

    for (var i=0; i<rows.length; i++) {
        let row = rows[i]
        await db.query('delete from comments where comment_post_id=? and comment_author=?', [row.comment_post_id, nuke_id], context.cxn)
        await reset_latest_comment(row.comment_post_id, context.cxn)
    }
    await db.query('delete from posts     where post_author=?',      [nuke_id], context.cxn)
    await db.query('delete from postviews where postview_user_id=?', [nuke_id], context.cxn)
    await db.query('delete from users     where user_id=?',          [nuke_id], context.cxn)

    try {
        await db.query(`insert into nukes (nuke_date, nuke_email, nuke_username, nuke_ip,  nuke_country) values
                   (now(), ?, ?, ?, ?)`, [u.user_email, u.user_name, u.user_last_comment_ip, country], context.cxn)
    }
    catch(e) { console.error(e) } // try-catch for case where ip is already in nukes table somehow

    return redirect(context.req.headers.referer) 
}

routes.GET.old = async function(context) {

    let years_ago = util.intval(util._GET(context.req.url, 'years_ago'))

    let user_id = context.current_user ? context.current_user.user_id : 0
    
    let sql = `select sql_calc_found_rows * from posts
               left join postviews on postview_post_id=post_id and postview_user_id= ?
               left join postvotes on postvote_post_id=post_id and postvote_user_id= ?
               left join users on user_id=post_author
               where post_approved=1 and
               post_date <          date_sub(now(), interval ${years_ago} year) and
               post_date > date_sub(date_sub(now(), interval ${years_ago} year), interval 1 year)
               order by post_date desc limit 40`

    let posts = await db.query(sql, [user_id, user_id], context.cxn)
    let s = (years_ago === 1) ? '' : 's'
    
    let content = html(
        head(conf, context),
        header(context),
        midpage(
            h1(`Posts from ${years_ago} year${s} ago`),
            post_list(posts, context)
        ),
        footer(context.admin_email),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.post = async function(context) { // show a single post and its comments

    let current_user_id = context.current_user ? context.current_user.user_id : 0
    let post_id         = util.intval(util.segments(context.req.url)[2]) // get post's cxn row number from url, eg 47 from /post/47/slug-goes-here

    let c
    if (c = util._GET(context.req.url, 'c')) { // permalink to a comment
        let offset = await cid2offset(post_id, c, context)
        return redirect(`/post/${post_id}?offset=${offset}#comment-${c}`)
    }

    let p = await get_post(post_id, context)
    if (!p)               return die('No post with that id', context)
    if (!p.post_approved) return die('That post is waiting for moderation', context)

    context.post = p // so that title is post title and not just domain

    let comments = await post_comment_list(p, context) // pick up the comment list for this post
    p.watchers   = await db.get_var(`select count(*) as c from postviews where postview_post_id=? and postview_want_email=1`, [post_id], context.cxn)
    p.post_views++ // increment here for display and in cxn on next line as record
    await db.query(`update posts set post_views = ? where post_id=?`, [p.post_views, post_id], context.cxn)
    const prev = await db.get_var(`select max(post_id) from posts where post_id < ?`, [post_id], context.cxn)
    const next = await db.get_var(`select min(post_id) from posts where post_id > ?`, [post_id], context.cxn)

    if (current_user_id) await update_postview(p, context)

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                prev_next(prev, next),
                format_post(p, context),
                comment_pagination(comments, context.req.url),
                comment_list(comments, context),
                comment_pagination(comments, context.req.url),
                comment_box(p, context)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.POST.post_login = async function(context) {
    const post_data    = await collect_post_data_and_trim(context)
    const current_user = await db.get_row('select * from users where user_email = ? and user_pass = ?', [post_data.email, util.md5(post_data.password)], context.cxn)
    const redirect_to  = context.req.headers.referer || '/'
    const headers      = current_user ? login_headers(current_user.user_id, current_user.user_pass, redirect_to) : login_headers(0, '', redirect_to)

    return({ code: 303, headers: headers, body: '' })
}

routes.GET.post_moderation = async function (context) {

    if (!context.current_user) return die('you must be logged in to moderate posts', context)

    let posts = await db.query(`select * from posts left join users on user_id=post_author where post_approved=0 or post_approved is null`, [], context.cxn)

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                post_list(posts, context)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.random = async function(context) {

    let rand = await db.get_var(`select round(rand() * (select count(*) from posts)) as r`, [], context.cxn)
    let p    = await db.get_var(`select post_id from posts limit 1 offset ?`, [rand], context.cxn)

    return redirect(`/post/${p}`)
}

routes.POST.recoveryemail = async function(context) {

    const post_data = await collect_post_data_and_trim(context)
    const message = await send_login_link(context.cxn, context.admin_email, post_data.user_email)

    const content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                h1(message)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.POST.register = async function(context) {

    let post_data = await collect_post_data_and_trim(context)

    const { user_id, message } = await create_user(post_data.user_name, post_data.user_email, context.admin_email, context.cxn)

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(`<h2>${message}</h2>`),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.subscribe = async function(context) { // for case user is already logged in and just wants to subscribe to newsletter
    if (!context.current_user) return redirect('/housing_news') // will show them subscription form

    db.query('update users set user_want_newsletter=1 where user_id=?', [context.current_user.user_id], context.cxn) // don't need to await it bc we don't care when it happens

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(`<h2>${context.current_user.user_email} is now subscribed</h2>`),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.POST.subscribe = async function(context) { // for case user is not logged in

    let post_data = await collect_post_data_and_trim(context)

    const { user_id, message } = await create_user(post_data.user_name, post_data.user_email, context.admin_email, context.cxn)

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(`<h2>${message}</h2>`),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.search = async function(context) {

    // if (is_robot()) return die('robots may not do searches', context)

    let s = util._GET(context.req.url, 's').trim().replace(/[^0-9a-z ]/gi, '') // allow only alphanum and spaces for now
    let us = encodeURI(s)

    if (!s) return die('You searched for nothing. It was found.', context)

    let [curpage, slimit, order, order_by] = util.which_page(util._GET(context.req.url, 'page'), util._GET(context.req.url, 'order'))

    // These match() requests require the existence of fulltext index:
    //      create fulltext index post_title_content_index on posts (post_title, post_content)

    // mysql match kinda sucks in that it won't match small words, so we union with a direct match on the title first
    // TODO: order by active, comments, likes, new
    let sql = ` select sql_calc_found_rows * from (
            select * from posts left join users on user_id=post_author where post_title='${s}'
            union
            select * from posts left join users on user_id=post_author where match(post_title, post_content) against ('${s}') limit 0, 20
        ) as t`

    let posts = await db.query(sql, [], context.cxn)

    let path = url.parse(context.req.url).pathname // "pathNAME" is url path without ? parms, unlike "path"

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                h1(`search results for "${s}"`),
                '<p>',
                post_pagination(posts.found_rows, curpage, `&s=${us}&order=${order}`, context.req.url),
                tabs(order, `&s=${us}`, path),
                post_list(posts, context),
                post_pagination(posts.found_rows, curpage, `&s=${us}&order=${order}`, context.req.url)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.since = async function(context) { // given a post_id and epoch timestamp, redirect to post's first comment after that timestamp

    // these will die on replace() if p or when is not defined and that's the right thing to do
    let p    = util.intval(util._GET(context.req.url, 'p'))
    let when = util.intval(util._GET(context.req.url, 'when'))

    let c = await db.get_var(`select comment_id from comments
                               where comment_post_id = ? and comment_date > from_unixtime(?)
                               order by comment_date limit 1`, [p, when], context.cxn)

    let offset = await cid2offset(p, c, context)
    let post = await get_post(p, context)
    return redirect(`${util.post2path(post)}?offset=${offset}#comment-${c}`)
}

routes.GET.cancel_stripe_subscription = async function(context) {

    if (!context.current_user)                          return die('Please log in first (so I know whose subscription to cancel)', context)
    if (!context.current_user.user_stripe_subscription) return die(`${context.current_user.user_name} does not have a subscription, so there is nothing to cancel.`, context)

    const stripe = require('stripe')(conf.stripe_api_key_live)
    const result = await stripe.subscriptions.del(context.current_user.user_stripe_subscription, {at_period_end: false});

    if ('canceled' === result.status) {
        db.query('update users set user_stripe_subscription=null, user_want_newsletter=0 where user_email=?',
            [context.current_user.user_email], context.cxn) // don't need to await, can happen later
        return die(`Your subscription has been cancelled. I enjoyed having you as a customer.<br>You can <a href='/housing_news'>resubscribe</a> any time.`, context)
    }
    else {
        return die(`Darn, something went wrong. Please email <a href='p@patrick.net'>p@patrick.net</a> to have him manually cancel your subscription.`, context)
    }
}

routes.POST.create_stripe_subscription = async function(context) {

    const { stripeToken, stripeTokenType, stripeEmail } = await collect_post_data_and_trim(context)

    if (!util.valid_email(stripeEmail)) return die('Stripe failed to return a valid email', context)

    const stripe   = require('stripe')(conf.stripe_api_key_live)
    const customer = await stripe.customers.create({ email: stripeEmail, source: stripeToken })

    if (!customer.id) return die('Stripe failed to create a customer.id', context)

    const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [ { plan: conf.stripe_plan_id } ], // use conf.stripe_plan_id when we are in production; or 'test_plan' when testing
    })

    if (!subscription.id) return die('Stripe failed to create a subscription.id', context)

    if (! await get_user_by_email(stripeEmail, context.cxn)) {
        const user_pass=util.md5(Date.now() + stripeEmail).slice(0,8)
        const insert_result = await db.query(`insert into users set user_level=2,
                                                                    user_registered=now(),
                                                                    user_name=?,
                                                                    user_pass=?,
                                                                    user_email=?,
                                                                    user_stripe_id=?,
                                                                    user_stripe_subscription=?`,
                                    [util.md5(stripeEmail).slice(0,8), user_pass, stripeEmail, customer.id, subscription.id], context.cxn)
        const user_id = insert_result.insertId

        // so that the header shows them as logged in right now, even tho browser did not send cookie
        context.current_user = await db.get_row('select * from users where user_id = ? and user_pass = ?', [user_id, user_pass], context.cxn)

        var content = html(
            head(conf, context),
            body(
                header(context),
                midpage(
                    `<h2>${stripeEmail} is now subscribed to patrick.net housing crash news!</h2>`,
                    `You are logged in to patrick.net and can change your user name and password <a href='/edit_profile'>here</a><p>`,
                    stripe_unsubscribe_button(),
                ),
                footer(context.admin_email),
            ),
            timings(context),
        )

        var headers = login_headers(user_id, user_pass, null, content)
    }
    else {
        await db.query('update users set user_stripe_id=?, user_stripe_subscription=? where user_email=?', [customer.id, subscription.id, stripeEmail], context.cxn)

        var content = html(
            head(conf, context),
            body(
                header(context),
                midpage(
                    `<h2>${stripeEmail} is now subscribed to patrick.net housing crash news!</h2>`,
                    stripe_unsubscribe_button(),
                ),
                footer(context.admin_email),
            ),
            timings(context),
        )

        var headers =    {
            'Content-Type' : 'text/html;charset=utf-8',
            'Expires'      : new Date().toUTCString(),
        }
    }

    return({ code: 200, headers: headers, body: content })
}

routes.GET.housing_news = async function (context) { // show the stripe and paypal subscription forms

    const newslinks       = await db.query('select * from newslinks where newslink_pubdate is not null order by newslink_pubdate desc', [], context.cxn)
    const formatted_links = newslink_list(newslinks)

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                '<h2>housing news</h2>',
                news_subscribe(context),
                formatted_links
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.unsubscribe = async function (context) { // unsubscribe from newsletter, just in local db for now (todo: cancel stripe or paypal as well from this)

    const user_id = util.intval(util._GET(context.req.url, 'user_id'))
    if (!user_id) return die('user_id parameter missing', context)

    const key = util._GET(context.req.url, 'key')
    if (!key)            return die('key parameter missing', context)
    if (key.length != 8) return die('key format invalid', context)

    let u = await db.get_row(`select * from users where user_id=?`, [user_id], context.cxn)
    if (!u)                           return die('invalid user_id', context)
    if (!u.user_pass.startsWith(key)) return die('wrong key', context)

    db.query('update users set user_want_newsletter=0 where user_id=?', [user_id], context.cxn) // don't need to await it bc we don't care when it happens

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(`<h2>${u.user_email} is now unsubscribed</h2>`),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.flag = async function(context) { // move a comment to moderation

    const comment_id = util.intval(util._GET(context.req.url, 'c'))

    if (!comment_id)                                          return send_html(200, '')
    if (!context.current_user)                                return send_html(200, '')
    if (!permissions.may_flag(context.current_user)) return send_html(200, '')

    const comment = await get_comment(comment_id, context.cxn)
    if (!comment) return send_html(200, '')

    if (util.valid_nonce(context) && comment_id) {
        await db.query(`update comments set comment_approved=0, comment_adhom_reporter=?, comment_adhom_when=now() where comment_id = ?`,
                    [context.current_user.user_id, comment_id], context.cxn)
    }

    const commenter_name = await db.get_var('select user_name from users where user_id=?', [comment.comment_author], context.cxn)

    mail(context.admin_email,
         context.admin_email,
        `comment by ${commenter_name} flagged by ${context.current_user.user_name}`,
        `${comment.comment_content} <a href='https://${conf.domain}/comment_moderation'>moderation page</a>`)

    return send_html(200, '') // blank response in all cases
}

routes.POST.update_profile = async function(context) { // accept data from profile_form

    if (!util.valid_nonce(context)) return die(invalid_nonce_message(), context)
    if (!context.current_user) return die('must be logged in to update profile', context)

    let post_data = await collect_post_data_and_trim(context)

    if (/\W/.test(post_data.user_name))          return die('Please go back and enter username consisting only of letters', context)
    if (!util.valid_email(post_data.user_email)) return die('Please go back and enter a valid email', context)

    const timezones = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York']
    post_data.user_timezone              = timezones[util.intval(post_data.user_timezone)]
    post_data.user_summonable            = util.intval(post_data.user_summonable)
    post_data.user_hide_post_list_photos = util.intval(post_data.user_hide_post_list_photos)

    if (post_data.user_aboutyou.match(/https?:/)) return die('Sorry, no links allowed in profile', context)
    post_data.user_aboutyou = util.strip_tags(post_data.user_aboutyou.linkify(), context.current_user)

    await db.query(`update users set user_email                 = ?,
                                  user_name                  = ?,
                                  user_timezone              = ?,
                                  user_summonable            = ?,
                                  user_hide_post_list_photos = ?,
                                  user_aboutyou              = ?  where user_id = ?`,
        [post_data.user_email,
         post_data.user_name,
         post_data.user_timezone,
         post_data.user_summonable,
         post_data.user_hide_post_list_photos,
         post_data.user_aboutyou,
         context.current_user.user_id], context.cxn).catch(error => {
            if (error.code.match(/ER_DUP_ENTRY/)) return die(`Sorry, looks like someone already took that email or user name`, context)
            else                                  return die(`Something went wrong with save`, context)
         })

    return redirect('/edit_profile?updated=true')
}

routes.POST.upload = async function(context) {
    return new Promise(function(resolve, reject) {
        if (!context.current_user) return reject('403:you must be logged in to upload images')

        var form = new formidable.IncomingForm()
        form.maxFieldsSize = 7 * 1024 * 1024 // max upload is 4MB, but this seems to fail; nginx config will block larger images anyway
        form.maxFields = 1                   // only one image at a time

        form.parse(context.req, async function (err, fields, files) {
            if (err) throw err

            let [url_path, abs_path] = await get_image_path()
            let clean_name           = util.clean_upload_path(abs_path, files.image.name, context.current_user)

            fs.rename(files.image.path, `${abs_path}/${clean_name}`, async function (err) { // note that files.image.path includes filename at end
                if (err) throw err

                let addendum = ''
                let dims     = await getimagesize(`${abs_path}/${clean_name}`).catch(error => { addendum = `"${error}"` })
                if (!dims) return reject('500:failed to find image dimensions')

                if (context.req.headers.referer.match(/edit_profile/)) { // uploading user icon
                    dims = await resize_image(`${abs_path}/${clean_name}`, 80)    // limit max width to 80 px
                    await update_icon(`${url_path}/${clean_name}`, dims, context)
                    return resolve(redirect('/edit_profile'))
                }
                else { // uploading image link to post or comment text area
                    if (dims[0] > MAXDIM) dims = await resize_image(`${abs_path}/${clean_name}`, MAXDIM)   // limit max width to MAXDIM px
                    addendum = `"<img src='${url_path}/${clean_name}' width='${dims[0]}' height='${dims[1]}' >"`

                    let content = `
                        <html>
                            <script>
                                var textarea = parent.document.getElementById('ta');
                                textarea.value = textarea.value + ${addendum};
                            </script>
                        </html>`

                    return resolve(send_html(200, content))
                }
            })
        })
    })
}

routes.GET.user = async function(context) {

    let current_user_id = context.current_user ? context.current_user.user_id : 0
    let [curpage, slimit, order, order_by] = util.which_page(util._GET(context.req.url, 'page'), util._GET(context.req.url, 'order'))
    let user_name = decodeURIComponent(util.segments(context.req.url)[2]).replace(/[^\w._ -]/g, '') // like /user/Patrick
    let u = await db.get_row(`select * from users where user_name=?`, [user_name], context.cxn)

    if (!u) return die(`no such user: ${user_name}`, context)

    // left joins to also get each post's viewing and voting data for the current user if there is one
    let sql = `select sql_calc_found_rows * from posts
               left join postviews on postview_post_id=post_id and postview_user_id= ?
               left join postvotes on postvote_post_id=post_id and postvote_user_id= ?
               left join users     on user_id=post_author
               where post_approved=1 and user_id=?
               ${order_by} limit ${slimit}`

    let posts = await db.query(sql, [current_user_id, current_user_id, u.user_id], context.cxn)

    let path = url.parse(context.req.url).pathname // "pathNAME" is url path without ? parms, unlike "path"

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                render_user_info(u, context),
                tabs(order, '', path),
                post_list(posts, context),
                post_pagination(posts.found_rows, curpage, `&order=${order}`, context.req.url),
                admin_user(u, context)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

routes.GET.watch = async function(context) { // toggle a watch from a post

    let post_id = util.intval(util._GET(context.req.url, 'post_id'))

    if (!context.current_user) return send_html(200, '')
    if (!util.valid_nonce(context)) return send_html(200, '')
    if (!post_id)              return send_html(200, '')

    let postview_want_email = await db.get_var(`select postview_want_email from postviews
                                             where postview_user_id=? and postview_post_id=?`,
                                             [context.current_user.user_id, post_id], context.cxn)

    if (postview_want_email) var want_email = 0 // invert
    else                     var want_email = 1

    await db.query(`insert into postviews (postview_user_id, postview_post_id, postview_want_email) values (?, ?, ?)
                 on duplicate key update postview_want_email=?`,
                [context.current_user.user_id, post_id, want_email, want_email], context.cxn)

    return send_html(200, render_watch_indicator(want_email))
}

routes.GET.nsfw = async function(context) { // mark a post as nsfw so porn images won't show on home page

    if (!permissions.may_mark_nsfw(context.current_user)) return send_html(200, '')

    let post_id = util.intval(util._GET(context.req.url, 'p'))
    let post    = await get_post(post_id, context)

    if (post.post_nsfw) var x = 0 // invert
    else                var x = 1

    if (util.valid_nonce(context) && post_id) await db.query(`update posts set post_nsfw=? where post_id = ?`, [x, post_id], context.cxn)

    mail(context.admin_email,
         context.admin_email,
        `post marked nsfw by ${context.current_user.user_name}`,
        `<a href='https://${conf.domain}/post/${post_id}'>see post</a>`)

    return send_html(200, x ? 'nsfw' : 'sfw')
}

// below are impure utility functions needed by the routes above

function send_html(code, body) {

    var headers =    {
        'Content-Type'   : 'text/html;charset=utf-8',
        'Expires'        : new Date().toUTCString()
    }

    return ({ code, headers, body })
}

function send_json(code, obj) {

    var headers =    {
        'Content-Type'   : 'text/html;charset=utf-8',
        'Expires'        : new Date().toUTCString()
    }

    return ({ code, headers, body: JSON.stringify(obj) })
}

function collect_post_data(context) { // if there is any POST data, accumulate it and return it in resolve()
    return new Promise(function(resolve, reject) {
        if (context.req.method === 'POST') {
            var content = ''

            context.req.on('data', function (data) {
                content += data

                if (content.length > 1e6) { // too much POST data, kill the connection
                    context.req.connection.destroy()
                    throw { code : 413, message : 'Too much POST data', }
                }
            })

            context.req.on('end', function () {
                resolve(querystring.parse(content))
            })
        }
        else {
            console.trace()
            reject(`attempt to collect_post_data from non-POST by ${context.ip}`)
        }
    })
}

async function collect_post_data_and_trim(context) { // to deal with safari on iphone tacking on unwanted whitespace to post form data
    let post_data = await collect_post_data(context)
    Object.keys(post_data).forEach(key => { post_data[key] = post_data[key].trim() })
    delete post_data.submit // because some browsers include submit as a data field
    return post_data
}

function mail(to, from, subject, html) {

    if (!to) return // because sometimes users do not have an email in database

	let transporter = nodemailer.createTransport({
		sendmail: true,
		newline:  'unix',
		path:     '/usr/sbin/sendmail',
        secure:   false, // do not use TLS
        tls: {
            rejectUnauthorized: false // do not fail on invalid certs
        }   
	})

    let options = { // from: will get filled in automatically with admin@<domain> if this is run as user admin
		to:      to,
		subject: subject,
		html:    html,
	}

    options.replyTo = from

    transporter.sendMail(options, (err, info) => {
        err && console.error(err)
        //console.log(info.envelope);
        //console.log(info.messageId);
    })
}

function getimagesize(file) {
    return new Promise(function(resolve, reject) {
        if (fs.existsSync(file)) {

            let { spawn } = require('child_process')
            let identify  = spawn('identify', ['-format', '%w %h', file]) // identify -format '%w %h' file

            identify.stdout.on('data', data => {
                let dims = data.toString('utf8').replace(/\n/,'').split(' ') // data is returned as string like '600 328\n'
                resolve([dims[0], dims[1]]) // width and height
            })

            identify.stderr.on('data', data => { // remove the file because something is wrong with it
                if (fs.existsSync(file)) fs.unlinkSync(file)
                reject('identify failed on image')
            })

            identify.on('close', code => {
                if (code > 0) { // if code is non-zero, remove the file because something is wrong with it
                    if (fs.existsSync(file)) fs.unlinkSync(file)
                    reject(`non-zero code from identify: ${code}`)
                }
            })

        } else {
            console.trace()
            reject(`image not found: ${file}`)
        }
    })
}

async function resize_image(file, max_dim = MAXDIM) { // max_dim is maximum dimension in either direction
    await mogrify(file, max_dim)
    return await getimagesize(file) // return the new image dimensions
}

function mogrify(file, max_dim = MAXDIM) { // max_dim is maximum dimension in either direction
    return new Promise(function(resolve, reject) {
        if (fs.existsSync(file)) {
            let { spawn } = require('child_process')
            let mog       = spawn('mogrify', ['-resize', max_dim, file]) // /usr/bin/mogrify -resize $max_dim $file

            mog.on('close', code => {
                if (code > 0) {
                    console.trace()
                    reject(`mogrify error: ${code}`) // todo: if code is non-zero, remove the file because something is wrong with it
                }
                else resolve(true)
            })
        } else {
            console.trace()
            reject(`image not found: ${file}`)
        }
    })
}

async function get_comment(comment_id, cxn) {
    return await db.get_row(`select * from comments where comment_id = ?`, [comment_id], cxn)
}

async function get_post(post_id, context) {

    if (context.current_user && context.current_user.user_id) {
        const user_id = context.current_user.user_id

        return await db.get_row(`select * from posts
                              left join postvotes on (postvote_post_id=post_id and postvote_user_id=?)
                              left join postviews on (postview_post_id=post_id and postview_user_id=?)
                              left join users on user_id=post_author where post_id=?`,
                              [user_id, user_id, post_id], context.cxn)
    }

    return await db.get_row(`select * from posts left join users on user_id=post_author where post_id = ?`, [post_id], context.cxn)
}

async function too_fast(ip, cxn) { // rate limit comment insertion by user's ip address
    const ago = await db.get_var(`select (unix_timestamp(now()) - unix_timestamp(user_last_comment_time)) as ago from users
                               where user_last_comment_time is not null and user_last_comment_ip = ?
                               order by user_last_comment_time desc limit 1`, [ip], cxn)

    return (ago && ago < 2) ? true : false // return true if this ip already commented less than two seconds ago
}

async function send_login_link(cxn, admin_email, user_email) {

    if (!util.valid_email(user_email)) return `Please go back and enter a valid email`

    const key      = util.md5(Math.random().toString())
    const key_link = `${BASEURL}/key_login?key=${ key }`
    const results  = await db.query('update users set user_activation_key=? where user_email=?', [key, user_email], cxn)

    if (results.changedRows) {
        const message = `Click here to log in and get your password: <a href='${ key_link }'>${ key_link }</a>`

        if ('dev' === process.env.environment) fs.writeFileSync('/tmp/login_link.html', message) // if in dev, do not actually mail so that we can work offline
        else                                   mail(user_email, admin_email, `Your ${ conf.domain } login info`, message)

        return `Please check your ${user_email} email for the login link`
    }
    else return `Could not find user with email ${ user_email }`
}

async function reset_latest_comment(post_id, cxn) { // reset post table data about latest comment, esp post_modified time

    if (!post_id) return

    let comment_row = await db.get_row(`select * from comments where comment_post_id=?  order by comment_date desc limit 1`, [post_id], cxn)

    if (comment_row) { // this is at least one comment on this post
        let post_comments = await db.get_var(`select count(*) as c from comments where comment_post_id=?`, [post_id], cxn)

        let firstwords = util.first_words(comment_row.comment_content, 40)

        await db.query(`update posts set
                     post_modified=?,
                     post_comments=?,
                     post_latest_comment_id=?,
                     post_latest_commenter_id=?,
                     post_latest_comment_excerpt=?
                     where post_id=?`,
                     [comment_row.comment_date,
                      post_comments,
                      comment_row.comment_id,
                      comment_row.comment_author,
                      firstwords,
                      post_id], cxn) // post_modified is necessary for sorting posts by latest comment
    }
    else { // there are no comments
        await db.query(`update posts set
                     post_modified=post_date,
                     post_comments=0,
                     post_latest_comment_id=0,
                     post_latest_commenter_id=0,
                     post_latest_comment_excerpt=''
                     where post_id=?`, [post_id], cxn)
    }
}

function redirect(redirect_to, code=303) { // put the code at the end; then if it isn't there we get a default

    const body = `Redirecting to ${ redirect_to }`

    const headers =  {
      'Location'       : redirect_to,
      'Content-Length' : body.length,
      'Expires'        : new Date().toUTCString()
    }

    return({ code, headers, body })
}

async function post_comment_list(post, context) {

    let offset = util.get_offset(post.post_comments, context.req.url)

    let user_id = context.current_user ? context.current_user.user_id : 0

    let sql = `select sql_calc_found_rows * from comments
               left join users on comment_author=user_id
               left join commentvotes on (comment_id = commentvote_comment_id and commentvote_user_id = ?)
               where comment_post_id = ?
               order by comment_date limit 40 offset ?`

    let comments = await db.query(sql, [user_id, post.post_id, offset], context.cxn)
    let found_rows = comments.found_rows

    // add in the comment row number to the result here for easier pagination info; would be better to do in mysql, but how?
    comments = comments.map(comment => {
        comment.row_number = ++offset
        return comment
    })

    comments.found_rows = found_rows // have to put this after map() above to retain it

    return comments
}

async function post_summons(post, context, already_mailed) { // post_content contains a summons like @user, and user is user_summonable, so email user the post

    var matches
    if (matches = post.post_content.match(/@(\w+)/m)) { // just use the first @user in the post, not multiple
        var summoned_user_username = matches[1]
        var u
        if (u = await db.get_row(`select * from users where user_name=? and user_id != ? and user_summonable=1`,
                                   [summoned_user_username, post.post_author], context.cxn)) {

            let subject  = `New ${conf.domain} post by ${post.user_name} directed at ${summoned_user_username}`

            let notify_message  = `<html><body><head><base href="${BASEURL}" ></head>
            New post by ${post.user_name}:  <a href='${BASEURL}${util.post2path(post)}'>${post.post_title}</a><p>
            <p>${post.post_content}<p>
            <p><a href='${BASEURL}${util.post2path(post)}'>Reply</a><p>
            <font size='-1'>Stop allowing <a href='${BASEURL}/profile'>@user summons</a></font></body></html>`

            if (u.user_email) mail(u.user_email, context.admin_email, subject, notify_message) // user_email could be null

            // include in already_mailed so we don't duplicate post emails for other reasons
            already_mailed[u.user_id] ? already_mailed[u.user_id]++ : already_mailed[u.user_id] = 1
        }
    }

    return already_mailed
}

async function post_followers(post, context, already_mailed) { // now do user follower emails

    let rows = []
    if (rows = await db.query(`select distinct rel_self_id as user_id from relationships where rel_other_id = ? and rel_i_follow > 0`,
                           [post.post_author], context.cxn)) {
        rows.forEach(async function(row) {

            if (already_mailed[row.rel_self_id]) return

            let u = await get_userrow(row.rel_self_id, context.cxn)

            if (!u) return

            let subject = `New ${conf.domain} post by ${post.user_name}`

            let notify_message  = `<html><body><head><base href="${BASEURL}" ></head>
            New post by ${post.user_name}, <a href='${BASEURL}${util.post2path(post)}'>${post.post_title}</a>:<p>
            <p>${post.post_content}<p>\r\n\r\n
            <p><a href='${BASEURL}${util.post2path(post)}'>Reply</a><p>
            <font size='-1'>Stop following <a href='${BASEURL}/user/${post.user_name}'>${post.user_name}</a></font><br>`

            mail(u.user_email, context.admin_email, subject, notify_message)
            already_mailed[u.user_id] ? already_mailed[u.user_id]++ : already_mailed[u.user_id] = 1
        })
    }

    return already_mailed
}

async function post_mail(p, context) { // reasons to send out post emails: @user, user following post author

    let post = await db.get_row(`select * from posts, users where post_id=? and post_author=user_id`, [p], context.cxn) // p is just the post_id

    let already_mailed = []

    already_mailed = already_mailed.concat(await post_summons(   post, context, already_mailed.slice())) // slice() so we don't modify array in fn, would be impure
    already_mailed = already_mailed.concat(await post_followers( post, context, already_mailed.slice()))
}

async function login(email, password, context) {

    context.current_user = await db.get_row('select * from users where user_email = ? and user_pass = ?', [email, util.md5(password)], context.cxn)

    // if they have a single unapproved comment, approve it and redirect them to it; assumption is that they just did a comment-registration
    const unapproved_comments = await db.query('select * from comments where comment_author=? and comment_approved=0', [context.current_user.user_id], context.cxn)
    if (1 === unapproved_comments.length) {
        await db.query('update comments set comment_approved=1 where comment_author=?', [context.current_user.user_id], context.cxn)
        const post   = await get_post(unapproved_comments[0].comment_post_id, context)
        const offset = await cid2offset(unapproved_comments[0].comment_post_id, unapproved_comments[0].comment_id, context)
        const link = `${util.post2path(post)}?offset=${offset}#comment-${unapproved_comments[0].comment_id}`
        var message = `Your password is ${ password } and your new comment is <a href='${ link }'>here</a>`
    }
    else {
        var message = `Your password is ${ password } and you are now logged in`
    }

    const content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                h1(message)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    const headers = login_headers(context.current_user.user_id, context.current_user.user_pass, null, content)

    return({ code: 200, headers: headers, body: content })
}

function login_headers(user_id, user_pass, redirect_to, content) {

    const usercookie = `patricknetuser=${ user_id   }`
    const pwcookie   = `patricknetpass=${ user_pass }`
    const d          = new Date()
    const decade     = new Date(d.getFullYear()+10, d.getMonth(), d.getDate()).toUTCString()
    if (redirect_to) content = ''
    const headers    = [ // you must use the undocumented "array" feature of writeHead to set multiple cookies, because json
        ['Content-Length' , content.length                            ],
        ['Content-Type'   , 'text/html'                               ],
        ['Expires'        , d.toUTCString()                           ],
        ['Set-Cookie'     , `${usercookie}; Expires=${decade}; Path=/`],
        ['Set-Cookie'     , `${pwcookie};   Expires=${decade}; Path=/`]
    ] // do not use 'secure' parm with cookie or will be unable to test login in dev, bc dev is http only

    if (redirect_to) headers.push(['Location', redirect_to])

    return headers
}

async function ip2country(ip, cxn) { // probably a bit slow, so don't overuse this
    if (!ip) return
    ip = ip.replace(/[^0-9\.]/, '')
    return await db.get_var(`select country_name from countries where inet_aton(?) >= country_start and inet_aton(?) <= country_end`, [ip, ip], cxn)
}

async function get_userrow(user_id, cxn) {
    return await db.get_row('select * from users where user_id = ?', [user_id], cxn)
}

async function get_user_by_name(user_name, cxn) {
    return await db.get_row('select * from users where user_name = ?', [user_name], cxn)
}

async function get_user_by_email(user_email, cxn) {
    return await db.get_row('select * from users where user_email = ?', [user_email], cxn)
}

async function get_comment_list_by_author(user, num, cxn, url) {
    let offset = util.get_offset(user.user_comments, url)
    return await db.query(`select sql_calc_found_rows * from comments left join users on comment_author=user_id
                        where user_name = ? order by comment_date limit ? offset ?`, [user.user_name, num, offset], cxn)
}

async function get_comment_list_by_number(n, offset, num, cxn) {
    return await db.query(`select sql_calc_found_rows * from comments, users force index (user_comments_index)
                        where comments.comment_author = users.user_id and user_comments = ? order by comment_date desc limit ? offset ?`,
                        [n, num, offset], cxn)
}

async function get_comment_list_by_search(s, offset, num, cxn) {
    return await db.query(`select sql_calc_found_rows * from comments left join users on comment_author=user_id
                        where match(comment_content) against (?) order by comment_date desc limit ? offset ?`, [s, num, offset], cxn)
}

async function get_comment_list_by_registration(offset, num, cxn) {
    return await db.query(`select sql_calc_found_rows * from comments left join users on comment_author=user_id order by user_registered desc limit ? offset ?`,
                          [num, offset], cxn)
}

async function comment_summons_mail(c, p, offset, already_mailed, context) {

    // if comment_content contains a summons like @user, and user is user_summonable, then email user the comment
    var matches
    if (matches = c.comment_content.match(/@(\w+)/m)) { // just use the first @user in the comment, not multiple
        let summoned_user_username = matches[1]
        var u
        if (u = await db.get_row(`select * from users where user_name=? and user_id != ? and user_summonable=1`,
                                   [summoned_user_username, c.comment_author], context.cxn)) {

            let subject  = `New ${conf.domain} comment by ${c.user_name} directed at ${summoned_user_username}`

            let notify_message  = `<html><body><head><base href="${BASEURL}" ></head>
            New comment by ${c.user_name} in <a href='${BASEURL}${util.post2path(p)}'>${p.post_title}</a>:<p>
            <p>${c.comment_content}<p>
            <p><a href='${BASEURL}${util.post2path(p)}?offset=${offset}#comment-${c.comment_id}'>Reply</a><p>
            <font size='-1'>Stop allowing <a href='${BASEURL}/profile'>@user summons</a></font></body></html>`

            if (u.user_email) mail(u.user_email, context.admin_email, subject, notify_message) // do not email if user_email is null in cxn

            // include in already_mailed so we don't duplicate emails below
            already_mailed[u.user_id] ? already_mailed[u.user_id]++ : already_mailed[u.user_id] = 1
        }
    }

    return already_mailed
}

async function following_post_mail(c, p, offset, already_mailed, context) {

    // commenter logged in right now probably doesn't want to get his own comment in email
    // select all other subscriber user ids and send them the comment by mail
    let sql = `select postview_user_id, postview_post_id from postviews
                    where postview_post_id=? and postview_want_email=1 and postview_user_id != ?
                    group by postview_user_id` // group by so that user_id is in there only once.

    let rows = []
    if (rows = await db.query(sql, [c.comment_post_id, c.comment_author], context.cxn)) {
        rows.forEach(async function(row) {

            if (already_mailed[row.postview_user_id]) return

            let u = await get_userrow(row.postview_user_id, context.cxn)
            if (!u) return

            let subject = `New ${conf.domain} comment in '${p.post_title}'`

            let notify_message  = `<html><body><head><base href="${BASEURL}" ></head>
            New comment by ${c.user_name} in <a href='${BASEURL}${util.post2path(p)}'>${p.post_title}</a>:<p>
            <p>${c.comment_content}<p>\r\n\r\n
            <p><a href='${BASEURL}${util.post2path(p)}?offset=${offset}#comment-${c.comment_id}'>Reply</a><p>
            <font size='-1'>Stop watching <a href='${BASEURL}${util.post2path(p)}?want_email=0'>${p.post_title}</a></font><br>
            <font size='-1'>Stop watching <a href='${BASEURL}/autowatch?off=true'>all posts</a></font></body></html>`

            mail(u.user_email, context.admin_email, subject, notify_message)
            already_mailed[u.user_id] ? already_mailed[u.user_id]++ : already_mailed[u.user_id] = 1
        })
    }

    return already_mailed
}

async function comment_mail(c, context) { // reasons to send out comment emails: @user summons, user watching post

    const p      = await get_post(c.comment_post_id, context)
    const offset = await cid2offset(p.post_id, c.comment_id, context)

    let already_mailed = []
    already_mailed = already_mailed.concat(await comment_summons_mail(c, p, offset, already_mailed.slice(), context))
    already_mailed = already_mailed.concat(await following_post_mail( c, p, offset, already_mailed.slice(), context))
}

async function cid2offset(post_id, comment_id, context) { // given a comment_id, find the offset
    return await db.get_var(`select floor(count(*) / 40) * 40 as o from comments
                          where comment_post_id=? and comment_id < ? order by comment_id`, [post_id, comment_id], context.cxn)
}

function die(message, context) {

    let content = html(
        head(conf, context),
        body(
            header(context),
            midpage(
                h2(message)
            ),
            footer(context.admin_email),
        ),
        timings(context),
    )

    return send_html(200, content)
}

async function allow_comment(post_data, context) {

    if (!util.valid_nonce(context))                  return { err: true, content: popup(invalid_nonce_message()) }
    if (!post_data.comment_content)                  return { err: true, content: '' } // empty comment, empty response
    //if (post_data.comment_content.match(/you/i))     return { err: true, content: popup('Please do not talk about the other users') }
    if (await too_fast(context.ip, context.cxn))     return { err: true, content: popup('You are posting comments too quickly') }
    if (await already_said_that(post_data, context)) return { err: true, content: popup('you already said that') }

    return { err: false, content: '' }
}

async function already_said_that(post_data, context) { // select the most recent comment by that user in that thread; if same as comment_content, return true
    const most_recent = await db.get_var(`select comment_content from comments where comment_post_id=? and comment_author=?
                                       order by comment_date desc limit 1`, [post_data.comment_post_id, post_data.comment_author], context.cxn)
    
    return (most_recent === post_data.comment_content) ? true : false
}

async function after_accept_comment(comment, context) {

    await reset_latest_comment(comment.comment_post_id, context.cxn)

    if (context.current_user) { // update postviews so that user does not see his own comment as unread
        await db.query(`insert into postviews (postview_user_id, postview_post_id, postview_last_view)
                     values (?, ?, now()) on duplicate key update postview_last_view=now()`,
                     [context.current_user.user_id, comment.comment_post_id], context.cxn)
    }

    // update comment count whether logged in or anon user
    await db.query(`update users set user_last_comment_ip = ?,
                 user_comments=(select count(*) from comments where comment_author = ?)
                 where user_id = ?`, [context.ip, comment.comment_author, comment.comment_author], context.cxn)

    if (comment.comment_approved) await comment_mail(comment, context)
}

async function hit_daily_post_limit(context) {

    if (!context.current_user)                  return true
    if ( context.current_user.user_level === 4) return false // admin has no limit

    var posts_today = await db.get_var('select count(*) as c from posts where post_author=? and post_date >= curdate()', [context.current_user.user_id], context.cxn)

    return (posts_today >= conf.max_posts) ? true : false
}

async function like_comment(user_id, user_name, context) {
    let comment_id  = util.intval(util._GET(context.req.url, 'comment_id'))
    let comment_row = await db.get_row(`select * from comments where comment_id=?`, [comment_id], context.cxn)

    if (!comment_row) return ''

    let vote = await db.get_var(`select commentvote_up c from commentvotes where commentvote_user_id=? and commentvote_comment_id=?`, [user_id, comment_id], context.cxn)

    if (vote) { // they already upvoted this one, so delete it
        await db.query(`update comments set comment_likes=comment_likes-1 where comment_id=?`, [comment_id], context.cxn)

        await db.query(`delete from commentvotes where commentvote_user_id=? and commentvote_comment_id=?`, [user_id, comment_id], context.cxn)

        await db.query(`update users set user_likes=user_likes-1 where user_id=?`, [comment_row.comment_author], context.cxn)

        return `&#8593;&nbsp;like (${comment_row.comment_likes - 1})`
    }
    else {
        await db.query(`update comments set comment_likes=comment_likes+1 where comment_id=?`, [comment_id], context.cxn)

        await db.query(`insert into commentvotes (commentvote_user_id, commentvote_comment_id, commentvote_up) values (?, ?, 1)
                     on duplicate key update commentvote_up=1`, [user_id, comment_id], context.cxn)

        await db.query(`update users set user_likes=user_likes+1 where user_id=?`, [comment_row.comment_author], context.cxn)

        if (1 === user_id) await db.query(`update users set user_pbias=user_pbias+1 where user_id=?`, [comment_row.comment_author], context.cxn)

        return `&#8593;&nbsp;you like this (${comment_row.comment_likes + 1})`
    }
}

async function send_comment_like_email(user_name, context) {
    let comment_id = util.intval(util._GET(context.req.url, 'comment_id'))
    let comment    = await db.get_row(`select * from comments where comment_id=?`, [comment_id], context.cxn)

    if (!comment) return

    // Now mail the comment author that his comment was liked, iff he has user_summonable set
    // todo: AND if current user has no record of voting on this comment! (to prevent clicking like over and over to annoy author with email)
    let offset = await cid2offset(comment.comment_post_id, comment.comment_id, context)
    let comment_url = `https://${conf.domain}/post/${comment.comment_post_id}?offset=${offset}#comment-${comment.comment_id}`

    let u = await db.get_row(`select * from users where user_id=?`, [comment.comment_author], context.cxn)

    if (util.intval(u && u.user_summonable)) {

        let subject  = `${user_name} liked your comment`

        let message = `<html><body><head><base href='https://${conf.domain}/' ></head>
        <a href='https://${conf.domain}/user/${user_name}' >${user_name}</a> liked the comment you made here:<p>\r\n\r\n
        <a href='${comment_url}' >${comment_url}</a><p>${comment.comment_content}<p>\r\n\r\n
        <font size='-1'>Stop getting <a href='https://${conf.domain}/edit_profile#user_summonable'>notified of likes</a>
        </font></body></html>
        ` // nice to have a newline at the end when getting pages on terminal

        mail(u.user_email, context.admin_email, subject, message)
    }
}

async function like_post(user_id, context) {
    let post_id = util.intval(util._GET(context.req.url, 'post_id'))

    let vote = await db.get_row(`select postvote_up, count(*) as c from postvotes where postvote_user_id=? and postvote_post_id=?`,
                             [user_id, post_id], context.cxn)

    if (vote && vote.c) { // if they have voted before on this, just return
        let post = await get_post(post_id, context)
        return String(post.post_likes)
    }

    await db.query(`update posts set post_likes=post_likes+1 where post_id=?`, [post_id], context.cxn)

    await db.query(`insert into postvotes (postvote_user_id, postvote_post_id, postvote_up) values (?, ?, 1)
                 on duplicate key update postvote_up=0`, [user_id, post_id], context.cxn)

    let post = await get_post(post_id, context)

    await db.query(`update users set user_likes=user_likes+1 where user_id=?`, [post.post_author], context.cxn)

    return String(post.post_likes)
}

async function send_post_like_email(user_name, context) {
    let post_id = util.intval(util._GET(context.req.url, 'post_id'))
    let post = await get_post(post_id, context)

    let post_url = 'https://' + conf.domain +  util.post2path(post)
    let u = await db.get_row(`select * from users where user_id=?`, [post.post_author], context.cxn)
    if (util.intval(u && u.user_summonable)) {

        let subject  = `${user_name} liked your post`

        let message = `<html><body><head><base href='https://${conf.domain}/' ></head>
        <a href='https://${conf.domain}/user/${user_name}' >${user_name}</a>
            liked the post you made here:<p>\r\n\r\n
        <a href='${post_url}' >${post_url}</a><p>${post.post_content}<p>\r\n\r\n
        <font size='-1'>Stop getting <a href='https://${conf.domain}/edit_profile#user_summonable'>notified of likes</a>
        </font></body></html>`

        mail(u.user_email, context.admin_email, subject, message)
    }
}

async function comments_to_moderate(context) {

    if (!context.current_user)               return []
    if (context.current_user.user_level < 3) return []

    return await db.query(`select * from comments left join users on user_id=comment_author left join posts on post_id=comment_post_id where
                        (comment_approved = 0 or comment_approved is null)`, [], context.cxn)
}

async function dislike_comment(user_id, context) {

    let comment_id  = util.intval(util._GET(context.req.url, 'comment_id'))
    let comment_row = await db.get_row(`select * from comments where comment_id=?`, [comment_id], context.cxn)
    if (!comment_row) return ''
    let vote        = await db.get_row(`select commentvote_up, count(*) as c from commentvotes where commentvote_user_id=? and commentvote_comment_id=?`,
                                    [user_id, comment_id], context.cxn)

    if (vote.c) return `&#8595;&nbsp; you dislike this (${comment_row.comment_dislikes})` // already voted on this comment

    await db.query(`update comments set comment_dislikes=comment_dislikes+1 where comment_id=?`, [comment_id], context.cxn)

    await db.query(`insert into commentvotes (commentvote_user_id, commentvote_comment_id, commentvote_down) values (?, ?, 1)
                 on duplicate key update commentvote_up=1`, [user_id, comment_id], context.cxn)

    await db.query(`update users set user_dislikes=user_dislikes+1 where user_id=?`, [comment_row.comment_author], context.cxn)

    // Now if admin was the disliker, then the user gets a bias bump down.
    if (1 === user_id) await db.query(`update users set user_pbias=user_pbias-1 where user_id=?`, [comment_row.comment_author], context.cxn)

    return `&#8595;&nbsp;you dislike this (${comment_row.comment_dislikes + 1})`
    // no emailing done of dislikes
}

async function dislike_post(user_id, context) {
    let post_id = util.intval(util._GET(context.req.url, 'post_id'))

    let vote = await db.get_row(`select postvote_down, count(*) as c from postvotes where postvote_user_id=? and postvote_post_id=?`,
                              [user_id, post_id], context.cxn)

    if (vote.c) { // if they have voted before on this, just return
        let post_row = await get_post(post_id, context)
        return String(post_row.post_dislikes)
    }

    await db.query(`update posts set post_dislikes=post_dislikes+1 where post_id=?`, [post_id], context.cxn)

    await db.query(`insert into postvotes (postvote_user_id, postvote_post_id, postvote_down) values (?, ?, 1) on duplicate key update postvote_down=0`,
                [user_id, post_id], context.cxn)

    let post_row = await get_post(post_id, context)

    await db.query(`update users set user_dislikes=user_dislikes+1 where user_id=?`, [post_row.post_author], context.cxn)

    return String(post_row.post_dislikes)
}

async function penalize(comment_author, context) { // decrement user_pbias
    if (context.current_user.user_id === comment_author) return // you can't penalize yourself
    await db.query(`update users set user_pbias=user_pbias-1 where user_id=?`, [comment_author], context.cxn)

    // if their pbias is below zero, make sure their user_level is set to 1 so that all their comments will go into moderation
    await db.query(`update users set user_level=1 where user_id=? and user_pbias < 0`, [comment_author], context.cxn)
}

async function update_postview(p, context) {

    p.postview_want_email = p.postview_want_email || 0 // keep as 1 or 0 from cxn; set to 0 if null in cxn

    if('0' === util._GET(context.req.url, 'want_email')) p.postview_want_email = 0

    await db.query(`replace into postviews set postview_user_id=?, postview_post_id=?, postview_last_view=now(), postview_want_email=?`,
                [context.current_user.user_id, p.post_id, p.postview_want_email], context.cxn)
}

async function update_user_post_count(context) {
    if (!context || !context.current_user) return

    const user_id = context.current_user.user_id

    await db.query(`update users set user_posts=(select count(*) from posts where post_author = ?) where user_id = ?`, [user_id, user_id], context.cxn)
}

function get_image_path(mkdirp = require('mkdirp')) {
    return new Promise(function(resolve, reject) {
        let d        = new Date()
        let mm       = ('0' + (d.getMonth() + 1)).slice(-2)
        let url_path = `/uploads/${d.getFullYear()}/${mm}`
        let abs_path = `${conf.doc_root}${url_path}`

        mkdirp(abs_path, function (err) {
            if (err) {
                console.error(err)
                reject(err)
            }
            else resolve([url_path, abs_path])
        })
    })
}

async function update_icon(path, dims, context) {
    let id = context.current_user.user_id
    await db.query(`update users set user_icon        = ? where user_id = ?`, [path,    id], context.cxn)
    await db.query(`update users set user_icon_width  = ? where user_id = ?`, [dims[0], id], context.cxn)
    await db.query(`update users set user_icon_height = ? where user_id = ?`, [dims[1], id], context.cxn)
}

async function create_user(user_name, user_email, admin_email, cxn) { // used by registration form and by comment-registration

    let message

    if (!util.valid_email(user_email)) return { user_id: 0, message: 'Please go back and enter a valid email' }

    let user
    let user_id

    if (user = await db.get_row('select * from nukes where nuke_email = ?', [user_email], cxn)) {
        return { user_id: 0, message: `Happiness comes from treating others as you wish to be treated.` }
    }

    if (user = await db.get_row('select * from users where user_email = ?', [user_email], cxn)) {
        user_id   = user.user_id
        user_name = user.user_name
    }
    else {
        if (!user_name)           return { user_id: 0, message: 'Please go back and enter a user name' }
        if (/\W/.test(user_name)) return { user_id: 0, message: 'Please go back and enter username consisting only of letters' }
        if (await db.get_row('select * from users where user_name = ?', [user_name], cxn)) {
            return { user_id: 0, message: `That user name is already registered. Please choose a different one.` }
        }

        const insert_result = await db.query('insert into users set user_level=2, user_want_newsletter=1, user_registered=now(), user_name=?, user_email=?',
                                             [user_name, user_email], cxn)
        user_id = insert_result.insertId
    }

    // notify admin that a new user has registered
    mail(admin_email, admin_email, `new user ${user_email} registered as ${user_name}`,
        `<a href='https://patrick.net/user/${user_name}'>https://patrick.net/user/${user_name}</a>`)

    message = await send_login_link(cxn, admin_email, user_email)

    return { user_id, message }
}
