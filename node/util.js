// all pure functions

'use strict'

const cheerio = require('cheerio')         // via npm to parse html
const crypto  = require('crypto')
const JSDOM   = require('jsdom').JSDOM
const url     = require('url')
const moment  = require('moment-timezone') // via npm for time parsing

let util = {}

exports = module.exports = util

util.flags = [  // index into this array will be stored in comments.comment_approved in db
    'flag',    // 0
    'approve', // 1
    'spam',    // 2
    'personal',
    'anti_forum',
    'doxing',
];

util.intval = function (s) { // return integer from a string or float
    return parseInt(s) ? parseInt(s) : 0
}

util.md5 = function (str, c=crypto) {
    var hash = c.createHash('md5')
    hash.update(str)
    return hash.digest('hex')
}

util.valid_email = function(email) {
    return /^\w.*@.+\.\w+$/.test(email)
}

util.strip_tags = function(s, current_user) {

    // these are the only allowed tags that users can enter in posts or comments; they will not be stripped; admin can use script tag as well
    let allowed = (current_user && current_user.user_level === 4) ?
        '<a><b><blockquote><br><code><del><font><hr><i><iframe><img><li><ol><p><script><source><strike><sub><sup><u><ul><video><vsmall>' :
        '<a><b><blockquote><br><code><del><font><hr><i><iframe><img><li><ol><p><source><strike><sub><sup><u><ul><video><vsmall>'

    allowed = (((allowed || '') + '')
        .toLowerCase()
        .match(/<[a-z][a-z0-9]*>/g) || [])
        .join('') // making sure the allowed arg is a string containing only tags in lowercase (<a><b><c>)

    var tags = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi
    var commentsAndPhpTags = /<!--[\s\S]*?-->|<\?(?:php)?[\s\S]*?\?>/gi

    return s.replace(commentsAndPhpTags, '').replace(tags, function($0, $1) {
        return allowed.indexOf('<' + $1.toLowerCase() + '>') > -1 ? $0 : ''
    })
}

util.strip_all_tags = function(s) {
    return s.replace(/(<([^>]+)>)/g,'')
}   

util.first_words = function(string, num) {

    string = util.strip_all_tags(string)

    let allwords   = string.split(/\s+/).map(s => s.substring(0, 30)) // max single word len is 30 chars
    let firstwords = allwords.slice(0, num)

    if (allwords.length > firstwords.length) return firstwords.join(' ') + '...'
    else                                     return firstwords.join(' ')
}

util.newlineify = function(s) { // transform the html shown in the edit box to be more human-friendly
    return s.replace(/<br>/gim, '\n')
            .replace(/<p>/gim,  '\n')
            .replace(/<\/p>/gim, '')
}

util.sanitize_html = function(s, j=JSDOM) {

    const allowed_attrs = { // allowed attributes for the allowed tags
        'a'          : ['href', 'title', 'rel', 'rev', 'name'],
        'b'          : [],
        'blockquote' : [],
        'br'         : [],
        'font'       : ['color', 'face'],
        'i'          : [],
        'iframe'     : ['src', 'height', 'width'],
        'img'        : ['alt', 'align', 'border', 'height', 'hspace', 'longdesc', 'vspace', 'src', 'width'],
        'li'         : [],
        'ol'         : [],
        'p'          : [],
        'strike'     : [],
        'u'          : [],
        'ul'         : [],
        'video'      : ['width', 'height', 'name', 'src', 'controls'],
        'vsmall'     : [],
    }

    const allowed_styles = [ 'background-color' ]

    const dom = new j(s)

    for (let tag in allowed_attrs) {
        let selection = dom.window.document.getElementsByTagName(tag)

        for (var i=0; i < selection.length; i++) {
            var item = selection[i]

            if (item.hasAttributes()) {
                for(var j = 0; j < item.attributes.length; j++) {
                    if (!allowed_attrs[tag].includes(item.attributes[j].name)) item.removeAttribute(item.attributes[j].name)
                }
            }
        }
    }

    return dom.serialize()
}

util.get_external_links = function(content, domain, ch=cheerio) {
    let c = ch.load(content)
    let extlinks = []

    c('a').each(function(i, elem) {

        if (!c(this).attr('href')) return // sometimes we get an a tag without an href, not sure how, but ignore them

        if (!(['http:', 'https:'].indexOf(url.parse(c(this).attr('href')).protocol) > -1)) return // ignore invalid protocols

        let host = url.parse(c(this).attr('href')).host
        if (new RegExp(domain).test(host)) return // ignore links back to own domain

        extlinks.push(c(this).attr('href'))
    })

    return extlinks
}

util.block_unknown_iframes = function(s, ch=cheerio) { // special case: iframes are allowed, but only with vimeo and youtube src

    let $ = ch.load(s)

    if (!$('iframe').length)    return s // do nothing if there is no iframe in s

    if ($('iframe').length > 1) return 'please edit this and post just one video at a time, thanks'

    var matches
    if (matches = $('iframe').attr('src').match(/(https?:)?\/\/([\w\.]+)/)) {
        var host = matches[2]
    }
    else return '' // not a valid frame src

    if (/vimeo.com/.test(host) || /youtube.com/.test(host)) return s
    else return '' // only vimeo or youtube videos are allowed so far
}

util.brandit = function(url, domain) { // add ref=[domain name] to a url

    if (!url) return

    if (!new RegExp(domain).test(url)) { // brand it iff url does not already have domain in it somewhere

        var matches
        if (matches = url.match(/(.*)\?(.*)/)) { // if E parms, add in ref=domain as first one to make it visible and harder to remove
            let loc         = matches[1]
            let querystring = matches[2]
            url = `${loc}?ref=${domain}&${querystring}`
        }
        else if (matches = url.match(/(.*)#(.*)/)) { // if no parms, but E hash tag, add in brand BEFORE that
            let loc        = matches[1]
            let hashstring = matches[2]
            url = `${loc}?ref=${domain}#${hashstring}`
        }
        else { // Otherwise, we're the only parm.
            url = url + `?ref=${domain}`
        }
    }

    return url
}

util.segments = function(path, u=url) { // return url path split up as array of cleaned \w strings
    if (!path) return
    return url.parse(path).path.replace(/\?.*/, '').split('/').map(segment => segment.replace(/[^\w%]/g,''))
}

util._GET = function (myurl, parm, u=url) { // given a string, return the GET parameter by that name
    if (!myurl) return ''
    return u.parse(myurl, true).query[parm] || '' // always return a string so string methods like trim will work even if parm undefined
}

util.valid_nonce = function (context) {

    const ts    = util._GET(context.req.url, 'ts')
    const nonce = util._GET(context.req.url, 'nonce')

    if (util.intval(ts) < (context.start_time - 7200000)) return false // don't accept timestamps older than two hours

    return (util.create_nonce(ts) === nonce) ? true : false
}

util.create_nonce = function (ts) {
    // create or check a nonce string for input forms. this makes each form usable only once; hopefully this slows down spammers and cross-site posting tricks
    return util.md5('x' + ts)
}

util.create_nonce_parms = function(context) {
    let nonce = util.create_nonce(context.start_time)
    return `ts=${context.start_time}&nonce=${nonce}`
}

util.render_date = function(gmt_date, utz='America/Los_Angeles', format='YYYY MMM D, h:mma', m=moment) { // create localized date string from gmt date out of mysql
    return m(Date.parse(gmt_date)).tz(utz).format(format)
}

util.slugify = function(s) { // url-safe pretty chars only; not used for navigation, only for seo and humans
    return s.replace(/\W+/g,'-').toLowerCase().replace(/-+/,'-').replace(/^-+|-+$/,'')
}

util.post2path = function(post) {
    let slug = JSON.stringify(post.post_date).replace(/"/g, '').substring(0, 10) + '-' + util.slugify(`${post.post_title}`)
    return `/post/${post.post_id}/${slug}`
}

util.maybe = function(path) { // maybe the object path exists, maybe not
    // we pass in a string, evaluate as an object path, then return the value or null
    // if some object path does not exit, don't just bomb with "TypeError: Cannot read property 'whatever' of null"

    let start = path.split('.')[0]

    try      { return path.split('.').slice(1).reduce((curr, key)=>curr[key], start) }
    catch(e) { return null }
}

util.clean_upload_path = function(path, filename, current_user) {

    if (!current_user) return ''

    // allow only alphanum, dot, dash in image name to mitigate scripting tricks
    // lowercase upload names so we don't get collisions on stupid case-insensitive Mac fs between eg "This.jpg" and "this.jpg"
    filename = filename.replace(/[^\w\.-]/gi, '').toLowerCase()

    var ext
    var matches
    if (matches = filename.match(/(\.\w{3,4})$/)) ext = matches[1] // include the dot, like .png

    if (filename.length > 128 ) filename = util.md5(filename) + ext // filename was too long to be backed up, so hash it to shorten it

    // prepend user_id to image so that we know who uploaded it, and so that other users cannot overwrite it
    filename = `${current_user.user_id}_${filename}`

    /* todo:
    if (preg_match( '/\.(jpg|jpeg)$/i' , $newname, $matches) && file_exists('/usr/bin/jpegoptim') ) {
        $output = shell_exec("/usr/bin/jpegoptim $newname 2>&1");  // minimize size of new jpeg
    }

    if (preg_match( '/\.(png)$/i' , $newname, $matches) && file_exists('/usr/bin/optipng') ) {
        $output = shell_exec("/usr/bin/optipng $newname 2>&1");  // minimize size of new png
    }
    */

    return filename
}

util.which_page = function(page, order) { // tell homepage, search, userpage which page we are on
    let curpage = Math.floor(page) ? Math.floor(page) : 1
    let slimit  = (curpage - 1) * 20 + ', 20' // sql limit for pagination of results.
    let orders = { // maps order parm to a posts table column name to order by
        'active'   : 'post_modified',
        'comments' : 'post_comments',
        'likes'    : 'cast(post_likes as signed) - cast(post_dislikes as signed)',
        'new'      : 'post_date',
    }

    order = orders[order] ? order : 'active'

    let order_by = 'order by ' + orders[order] + ' desc'

    return [curpage, slimit, order, order_by]
}

util.get_offset = function(total, url) {
    let offset = (total - 40 > 0) ? total - 40 : 0                // if offset is not set, select the 40 most recent comments
    if (util._GET(url, 'offset')) offset = util.intval(util._GET(url, 'offset')) // but if offset is set, use that instead

    return offset
}

Number.prototype.number_format = function() {
    return this.toLocaleString('en')
}

Array.prototype.sortByProp = function(p) {
    return this.sort(function(a,b) {
        return (a[p] > b[p]) ? 1 : (a[p] < b[p]) ? -1 : 0
    })
}

String.prototype.linkify = function() {

    let blockquotePattern = /""(.+?)""/gim
    let boldPattern       = / \*(.+?)\*/gim
    let emailpostPattern  = /([\w.]+@[a-zA-Z_-]+?(?:\.[a-zA-Z]{2,6})+)\b(?!["<])/gim
    let imagePattern      = /((https?:\/\/[\w$%&~\/.\-;:=,?@\[\]+]*?)\.(jpg|jpeg|gif|gifv|png|bmp))(\s|$)/gim
    let ipadPattern       = /Sent from my iPad/gim
    let italicPattern     = / _(.+?)_/gim
    let linebreakPattern  = /\n/gim
    let pseudoUrlPattern  = /(^|[^\/])(www\.[\S]+(\b|$))(\s|$)/gim                                    // www. sans http:// or https://
    let urlPattern        = /\b(https?:\/\/[a-z0-9-+&@#\/%?=~_|!:,.;]*[a-z0-9-+&@#\/%=~_|])(\s|$)/gim // http://, https://
    let vimeoPattern      = /(?:^|\s)[a-zA-Z\/\/:\.]*(player.)?vimeo.com\/(video\/)?([a-zA-Z0-9]+)/i
    let youtubePattern    = /(?:^|\s)[a-zA-Z\/\/:\.]*youtu(be.com\/watch\?v=|.be\/|be.com\/v\/|be.com\/embed\/)([a-zA-Z0-9\-_]+)([a-zA-Z0-9\/\*\-\_\?\&\;\%\=\.]*)/i

    let result = this
        .trim()
        .replace(/\r/gim,          '')
        .replace(ipadPattern,      '')
        .replace(vimeoPattern,     '<iframe src="//player.vimeo.com/video/$3" width="500" height="375" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe>')
        .replace(youtubePattern,   '<iframe width="500" height="375" src="//www.youtube.com/embed/$2$3" allowfullscreen></iframe>')
        .replace(imagePattern,     '<img src="$1"> ')
        .replace(urlPattern,       '<a href="$1">$1</a> $2')
        .replace(pseudoUrlPattern, '$1<a href="http://$2">$2</a> ')
        .replace(emailpostPattern, '<a href="mailto:$1">$1</a> ')
        .replace(linebreakPattern, '<br>')
        .replace(boldPattern,      ' <b>$1</b>')
        .replace(italicPattern,    ' <i>$1</i>')
        .replace(blockquotePattern,'<blockquote>$1</blockquote>')
        .replace(/\0/g,            '') // do not allow null in strings

    result = util.block_unknown_iframes(result)
    result = util.sanitize_html(result)

    return result
}

