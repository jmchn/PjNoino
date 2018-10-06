'use strict'

const conf  = require('./_conf.json') // _conf.json is required
const mysql = require('mysql2')        // via npm to interface to mysql

let db    = {}
let locks = {} // db locks to allow only one db connection per ip; helps mitigate dos attacks
let pool  = mysql.createPool(conf.db)

exports = module.exports = db

pool.query('select 1 + 1', (error, results, fields) => {
    if (error) {
        pool = null // so we can detect when serving responses
        throw new Error('could not connect to mysql')
    }
})

db.get_connection_from_pool = function(ip) {
    return new Promise(function(resolve, reject) {

        if (locks[ip]) return reject(new Error('429:rate limit exceeded'))

        locks[ip] = Date.now() // set a database lock for this ip; each ip is allowed only one outstanding connection at a time

        pool.getConnection(function(err, cxn) {
            if (err) {
                console.trace()
                reject(err)
            }
            else {
                cxn.queries = []
                setTimeout((cxn, ip) => { db.release_connection_to_pool(cxn, ip) }, 2000) // don't let lock last for more than two seconds
                resolve(cxn)
            }
        })
    })
}

db.release_connection_to_pool = function(cxn, ip) {
    if (cxn) cxn.release()
    delete locks[ip]
}

db.query = function(sql, sql_parms, cxn, debug) {
    return new Promise(function(resolve, reject) {
        var query

        if (!cxn) {
            console.trace()
            return reject('500:attempt to use cxn without connection')
        }

        var get_results = async function (error, results, fields, timing) { // callback to give to cxn.query()

            if (debug) console.log(query.sql)

            if (error) {
                console.error('cxn error when attempting to run: ' + query.sql + ' ---> ' + error)
                console.trace()
                return reject(error)
            }

            cxn.queries.push({ // for logging within the html footer
                sql : query.sql,
                ms  : timing
            })

            if (query.sql.match(/sql_calc_found_rows/)) results.found_rows = await sql_calc_found_rows(cxn) // total that would be found without a limit

            return resolve(results)
        }

        query = sql_parms ? cxn.query(sql, sql_parms, get_results)
                          : cxn.query(sql,            get_results)
    })
}

db.get_var = async function(sql, sql_parms, cxn) {
    let results = await db.query(sql, sql_parms, cxn)
    
    if (results.length) {
        let firstkey = Object.keys(results[0])
        return results[0][firstkey]
    }
    else return null
}

db.get_row = async function(sql, sql_parms, cxn) {
    let results = await db.query(sql, sql_parms, cxn)
    return results.length ? results[0] : null
}

async function sql_calc_found_rows(cxn) { // not exported
    return await db.get_var('select found_rows() as f', [], cxn)
}
