// html components
// * all are pure synchronous functions: no reading outside parms, no modification of parms, no side effects, can be replaced with ret value
// * all return strings of html or text
// * all html without a unique html tag has an id which includes name of the function which generated it

'use strict'

const cheerio     = require('cheerio')         // via npm to parse html
const conf        = require('./_conf')
const moment      = require('moment-timezone') // via npm for time parsing
const permissions = require('./permissions')
const url         = require('url')
const util        = require('./util')

let components = {}

exports = module.exports = components

components.stripe_unsubscribe_button = function() {
    return `<p><div id='components.stripe_unsubscribe_button' ><a href='/cancel_stripe_subscription'><button>Cancel Subscription</button></a></div>`
}

components.news_subscribe = function(context) {

    if (context.current_user && context.current_user.user_want_newsletter) return `<b>You are subscribed</b><p>
        <a href='/unsubscribe?user_id=${context.current_user.user_id}&key=${context.current_user.user_pass.substring(0, 8)}'><button>unsubscribe</button></a><br>`

    const ad = '<b>Subscribe to the housing news for free. Goes out MWF. Instant unsubscribe.</b><p>'

    if (context.current_user && !context.current_user.user_want_newsletter) return `${ad}<a href='/subscribe'><button>subscribe</button></a><br>`

    return `${ad}${components.name_email_form('subscribe')}`
}

components.stripe_form = function(context) {

    if (context.current_user && context.current_user.user_stripe_subscription) return '<b>You have an active subscription</b>'

    const email = context.current_user ? context.current_user.user_email : ''

    return `
        <h2>Patrick.net housing news</h2>
        <h3>$5.46 per month, cancel any time.<br>Emailed Mon, Wed, Fri</h3>
        Goes great with your morning coffee.<p>
        <form action='/create_stripe_subscription' method='POST'>
            <script src='https://checkout.stripe.com/checkout.js' defer async class='stripe-button'
                data-amount      = '546'
                data-description = 'monthly subscription'
                data-email       = '${email}'
                data-image       = 'https://patrick.net/uploads/2015/02/icon.png'
                data-key         = '${conf.stripe_publishable_key}'
                data-label       = 'Sign me up!'
                data-locale      = 'auto'
                data-name        = 'Patrick.net Housing News'
                >
            </script>
        </form>`
}

components.invalid_nonce_message = function() {
    return `invalid nonce. reload this page and try again`
}

components.newslink_email = function(newslinks, user_id, key, u=url) {
    return `<html>
    <h3>Patrick.net Housing News</h3>
    <div id='newslink_list' >
    ${ components.newslink_list(newslinks, false, u=url) }
    </div><p>
    Enjoy this email? Forward it to a friend!
    <hr>
    <a href='https://patrick.net/unsubscribe?user_id=${user_id}&key=${key}'>unsubscribe instantly</a><br>
    <a href='https://patrick.net/housing_news'>subscribe</a><br>
    </html>`
}

components.newslink_list = function(newslinks, with_del, u=url) {
    let date = ''
    let ret  = ''

    if (!newslinks.length) return '<b>no newslinks found</b><hr>'

    newslinks.map(item => {
        
        if (item.newslink_pubdate && (date.toString() != item.newslink_pubdate.toString())) {
            date = item.newslink_pubdate.toString()
            ret += `<hr><p><b>${date.split(/ /).slice(0,4).join(' ')}</b></p>`
        }

        const X = with_del ? `<a href='/delete_newslink?newslink_id=${item.newslink_id}'>X</a> ` : ''

        ret += `
            <p>${X}
            <a href='${item.newslink_url}'>${item.newslink_title}</a>
            (${u.parse(item.newslink_url).host.replace(/www./, '').substring(0, 31)})
            <a href='https://${conf.domain}/post/${item.newslink_post_id}'>comments</a></p>
            `
    })

    return ret
}

components.comment_list = function(comments, context, u = util) { // format one page of comments

    let offset = u._GET(context.req.url, 'offset')

    return `<div id='comment_list' >
    ${ comments.length ? comments.map(item => components.format_comment(item, context, comments, offset)).join('') : '<b>no comments found</b>' }
    </div>`
}

components.render_user_icon = function(u, scale=1, img_parms='') { // clickable icon for this user if they have icon

    var user_icon_width  = Math.round(u.user_icon_width  * scale)
    var user_icon_height = Math.round(u.user_icon_height * scale)

    return u.user_icon ?
            `<a href='/user/${ u.user_name }' id='render_user_icon' >
                <img src='${u.user_icon}' width='${user_icon_width}' height='${user_icon_height}' ${img_parms} >
             </a>` : ''
}

components.format_comment = function(c, context, comments, offset, u=url) {

    const current_user = context.current_user

    let hide = ''

    if (current_user && c.comment_approved) { // suppress approved comments if user is ignoring or is ignored
        if (current_user.relationships[c.user_id]       && current_user.relationships[c.user_id].rel_i_ban)       hide = `style='display: none'` // i'm ignoring this user
        if (current_user.relationships_other[c.user_id] && current_user.relationships_other[c.user_id].rel_i_ban) hide = `style='display: none'` // this user is ignoring me
    }

    c.user_name = c.user_name || 'anonymous' // so we don't display 'null' in case the comment is anonymous

    // for the last comment in the whole result set (not just last on this page) add an id="last"
    // comments may not be defined, for example when we just added one comment
    if (comments)
        var last = (c.row_number === comments.found_rows) ? `<span id='last'></span>` : ''
    else
        var last = ''

    const clinks      = components.comment_links(c, context, offset)
    const reason      = (c.comment_approved != 1) && util.flags[c.comment_approved]; // reason not to show this comment
    const is_mod_page = Boolean(u.parse(context.req.url).pathname.match(/comment_moderation/) && (current_user.user_level >= 3)) 
    const mlinks      = is_mod_page ? util.flags.slice(1).map(flag => flag_link(context, c, flag)) : [];

    return `${last}<div class="comment" id="comment-${c.comment_id}" ${hide} >
    <font size=-1 >
        ${c.row_number || ''}
        &nbsp;
        ${components.render_user_icon(c, 0.4, `'align='left' hspace='5' vspace='2'`)}
        ${c.user_name ? `<a href='/user/${c.user_name}'>${c.user_name}</a>` : 'anonymous'}
        &nbsp;
        ${clinks.join(' &nbsp; ')}
        &nbsp;
        ${is_mod_page ? mlinks.join(' &nbsp; ') : '' }
    </font><p><div id='comment-${c.comment_id}-text'>${ (reason && !is_mod_page) ? '<i>'+reason+'</i>' : c.comment_content }</div></div>`
}

function flag_link(context, c, flag) {
    return `<a href='#'
               onclick="if (confirm('Really flag?')) { $.get('/judge_comment?flag=${ flag }&comment_id=${ c.comment_id }&${util.create_nonce_parms(context)}',
                   function() { $('#comment-${ c.comment_id }').remove() }
               ); return false }; return false" >${ flag }</a>`
}

components.comment_links = function(c, context, offset) { // return links to be placed above the comment

    const current_user = context.current_user
    const ip           = context.ip
    const req          = context.req

    if (!req.url) return

    const liketext    = c.commentvote_up   ? 'you like this'    : '&#8593;&nbsp;like'
    const disliketext = c.commentvote_down ? 'you dislike this' : '&#8595;&nbsp;dislike'

    const likeaction    = current_user ? `like('like_${c.comment_id}');       return false` : 'midpage.innerHTML = registerform.innerHTML; return false'
    const dislikeaction = current_user ? `dislike('dislike_${c.comment_id}'); return false` : 'midpage.innerHTML = registerform.innerHTML; return false'

    let links = []

    links.push(`<a href='#' onclick="if (confirm('Really ignore ${c.user_name}?')) { $.get('/ignore?other_id=${ c.user_id }&${util.create_nonce_parms(context)}', function() { $('#comment-${ c.comment_id }').remove() }); return false}; return false" title='ignore ${c.user_name}' >ignore (${c.user_bannedby})</a>`)
    links.push(get_permalink(c, current_user ? current_user.user_timezone : 'America/Los_Angeles'))
    links.push(`<a href='#' id='like_${c.comment_id}'    onclick="${likeaction}"   >${liketext}    (${c.comment_likes})</a>`)
    links.push(`<a href='#' id='dislike_${c.comment_id}' onclick="${dislikeaction}">${disliketext} (${c.comment_dislikes})</a>`)
    links.push(`<a href="#commentform"
                    onclick="addquote('${c.comment_post_id}', '${offset}', '${c.comment_id}', '${c.user_name}'); return false;"
                    title="select some text then click this to quote" >quote</a>`)
    if (c.comment_approved == 1) links.push(flag_link(context, c, 'flag')) // only approved comments can be flagged
    links.push(get_edit_link(c, context))
    links.push(get_del_link(c, context))
    links.push(get_nuke_link(c, context))

    return links
}

function get_permalink(c, utz) {
    return `<a href='/post/${c.comment_post_id}/?c=${c.comment_id}' title='permalink' >${util.render_date(c.comment_date, utz)}</a>`
}

function get_edit_link(comment, context) {

    const current_user = context.current_user

    if (!current_user) return ''

    if (permissions.may_delete_comment(comment, current_user)) { // edit permissions same as delete permissions
        return `<a href='/edit_comment?c=${comment.comment_id}&${util.create_nonce_parms(context)}'>edit</a>`
    }

    return ''
}

function get_nuke_link(c, context, u=url) {
    const current_user = context.current_user
    const req          = context.req

    if (!current_user) return ''
    if (!req.url)      return ''

    return (u.parse(req.url).pathname.match(/comment_moderation/) && (current_user.user_level === 4)) ?
        `<a href='/nuke?nuke_id=${c.comment_author}&${util.create_nonce_parms(context)}' onClick='return confirm("Really?")' >nuke</a>` : ''
}

function get_del_link(comment, context) {

    const current_user = context.current_user

    return permissions.may_delete_comment(comment, current_user) ?
           `<a href='#' onclick="if (confirm('Really delete?')) { $.get('/delete_comment?comment_id=${ comment.comment_id }&post_id=${ comment.comment_post_id }&${util.create_nonce_parms(context)}', function() { $('#comment-${ comment.comment_id }').remove() }); return false}">delete</a>` : ''
}

components.get_first_image = function(post, ch=cheerio) {

    let c = ch.load(post.post_content)

    if (!c('img').length) return ''

    let src = post.post_nsfw ? '/icons/nsfw.png' : c('img').attr('src')

    return `<div class='icon' ><a href='${util.post2path(post)}' ><img src='${src}' border=0 width=100 align=top hspace=5 vspace=5 ></a></div>`
}

components.latest_comment = function(post, m=moment) {

    let ago  = m(post.post_modified).fromNow() // impure!
    let num  = post.post_comments.number_format()
    let path = util.post2path(post)
    let s    = post.post_comments === 1 ? '' : 's'

    return post.post_comments ?
        `<a href='${path}'>${num}&nbsp;comment${s}</a>, latest <a href='${path}#comment-${post.post_latest_comment_id}' >${ago}</a>` :
        `<a href='${util.post2path(post)}'>Posted ${ago}</a>`
}

components.extlink = function(post, c=conf, u=url) { // format first external link from post
    let extlinks = util.get_external_links(post.post_content, conf.domain)
    if (extlinks && extlinks.length && u.parse(extlinks[0]).host) {
        return components.extlink_domain(extlinks[0])
    }
    else return ''
}

components.extlink_domain = function(extlink, c=conf, u=url) { // format external link as (domain.com)
    const host = u.parse(extlink).host.replace(/www./, '').substring(0, 31)
    return ` (<a href='${util.brandit(extlink, conf.domain)}' target='_blank' title='original story' >${host}</a>)`
}

components.render_unread_comments_icon = function(post, current_user) { // return the blinky icon if there are unread comments in a post

    if (!current_user) return ''

    // if post.post_latest_commenter_id is an ignored user, just return
    // prevents user from seeing blinky for ignored users, but unfortunately also prevents blinky for wanted unread comments before that
    if (current_user
     && current_user.relationships
     && current_user.relationships[post.post_latest_commenter_id]
     && current_user.relationships[post.post_latest_commenter_id].rel_i_ban) return ''

    if (!post.postview_last_view)
        return `<a href='${util.post2path(post)}' ><img src='/icons/unread_post.gif' width='45' height='16' title='You never read this one' ></a>`

    // if post_modified > last time they viewed this post, then give them a link to earliest unread comment
    let last_viewed = Date.parse(post.postview_last_view) / 1000
    let modified    = Date.parse(post.post_modified) / 1000

    if (modified > last_viewed) {

        let unread = `<a href='/since?p=${post.post_id}&when=${last_viewed}' ><img src='/icons/unread_comments.gif' width='19' height='18' title='View unread comments'></a>`

        return unread
    }
    else return ''
}

components.post_summary = function(post, current_user, moderation, nonce_parms) { // format item in list of posts according to user and whether post is in moderation
    const unread        = components.render_unread_comments_icon(post, current_user) // last view by this user, from left join
    const imgdiv        = (current_user && current_user.user_hide_post_list_photos) ? '' : components.get_first_image(post)
    const arrowbox_html = components.arrowbox(post, current_user)
    const firstwords    = `<font size='-1'>${util.first_words(post.post_content, 30)}</font>`

    const approval_link = moderation ? ` <a href='#' onclick="$.get('/approve_post?post_id=${post.post_id}&${nonce_parms}',
        function() { $('#post-${ post.post_id }').remove() }); return false">approve</a>` : ''

    const delete_link = permissions.may_delete_post(post, current_user) ?
        ` <a href='/delete_post?post_id=${post.post_id}&${nonce_parms}' onClick="return confirm('Really delete?')" id='delete_post' >delete</a> &nbsp;` : ''

    const nuke_link = moderation ? ` <a href='/nuke?nuke_id=${post.post_author}&${nonce_parms}' onClick='return confirm("Really?")' >nuke</a>` : ''

    const latest = components.latest_comment(post)

    const link = `<b>${components.post_link(post)}</b>${components.extlink(post)}`

    const utz = current_user ? current_user.user_timezone : 'America/Los_Angeles'
    const date = util.render_date(post.post_date, utz, 'D MMM YYYY')

    return `<div class='post' id='post-${post.post_id}' >${arrowbox_html}${imgdiv}${link}
    <br>by <a href='/user/${ post.user_name }'>${ post.user_name }</a> on ${date}&nbsp;
    ${latest} ${unread} ${approval_link} ${delete_link} ${nuke_link}<br>${firstwords}</div>`
}

components.post_list = function(posts, context, u=url) { // format a list of posts from whatever source

    var current_user = context.current_user
    var url          = context.req.url

    if (!url) return ''
    if (!posts) return ''

    let nonce_parms = util.create_nonce_parms(context)
    
    posts = posts.filter(post => {
        if (!current_user && post.post_title.match(/thunderdome/gi)) return false // hide thunderdome posts if not logged in
        if (!current_user && post.post_nsfw)                         return false // hide porn posts if not logged in

        if (current_user                                 &&
            current_user.relationships[post.post_author] &&
            current_user.relationships[post.post_author].rel_i_ban)  return false

        return true
    })

    let moderation = (u.parse(url).pathname.match(/post_moderation/) && (current_user.user_level === 4)) ? 1 : 0

    return posts.map(post => components.post_summary(post, current_user, moderation, nonce_parms)).join('')
}

components.arrowbox = function(post, current_user) { // output html for vote up/down arrows; takes a post left joined on user's votes for that post

    var upgrey   = post.postvote_up   ? `style='color: grey; pointer-events: none;'` : ``
    var downgrey = post.postvote_down ? `style='color: grey; pointer-events: none;'` : ``

    const likeaction    = current_user ? `postlike('post_${post.post_id}_up'); return false;`     : 'midpage.innerHTML = registerform.innerHTML; return false'
    const dislikeaction = current_user ? `postdislike('post_${post.post_id}_down');return false;` : 'midpage.innerHTML = registerform.innerHTML; return false'

    var likelink    = `href='#' ${upgrey}   onclick="${likeaction}"`
    var dislikelink = `href='#' ${downgrey} onclick="${dislikeaction}"`

    return `<div class='arrowbox' >
            <a ${likelink}    title='${post.post_likes} upvotes'      >&#9650;</a><br>
            <span id='post_${post.post_id}_up' />${post.post_likes}</span><br>
            <span id='post_${post.post_id}_down' />${post.post_dislikes}</span><br>
            <a ${dislikelink} title='${post.post_dislikes} downvotes' >&#9660;</a>
            </div>`
}

components.post_link = function(post) {
    let path = util.post2path(post)
    return `<a href='${path}' >${post.post_title}</a>`
}

components.render_upload_form = function (){

    return `
    <form enctype='multipart/form-data' id='upload-file' method='post' target='upload_target' action='/upload' >
        <input type='file'   id='upload'   name='image' class='form' /> 
        <input type='submit' value='Include Image' class='form' />
    </form>
    <iframe id='upload_target' name='upload_target' src='' style='display: none;' ></iframe>` // for uploading a bit of js to insert the img link
}

components.comment_edit_box = function(comment, context) { // edit existing comment, redirect back to whole post page

    var current_user = context.current_user
    var ip           = context.ip

    comment.comment_content = util.newlineify(comment.comment_content)

    return `
    <h1>edit comment</h1>
    ${current_user ? components.render_upload_form() : ''}
    <form id='commentform' action='/accept_edited_comment?${util.create_nonce_parms(context)}' method='post' >
        <textarea id='ta' name='comment_content' class='form-control' rows='10' placeholder='write a comment...' >${comment.comment_content}</textarea><p>
        <input type='hidden' name='comment_id' value='${comment.comment_id}' />
        <button type='submit' id='submit' class='btn btn-success btn-sm' >submit</button>
    </form>
    <script>document.getElementById('ta').focus();</script>`
}

components.post_form = function(p, post) { // used both for composing new posts and for editing existing posts; distinction is the presence of p, the post_id

    const fn      = p ? 'edit' : 'new post'
    const title   = p ? post.post_title.replace(/'/g, '&apos;') : '' // replace to display correctly in single-quoted html value below
    const content = p ? util.newlineify(post.post_content.replace(/'/g, '&apos;')) : ''
    const post_id = p ? `<input type='hidden' name='post_id' value='${post.post_id}' />` : ''

    return `
    <h1>${fn}</h1>
    <form action='/accept_post' method='post' name='postform' >
        <div class='form-group'><input name='post_title' type='text' class='form-control' placeholder='title' id='title' value='${title}' ></div>
        <textarea class='form-control' name='post_content' rows='12' id='ta' name='ta' >${content}</textarea><p>
        ${post_id}
        <button type='submit' id='submit' class='btn btn-success btn-sm' >submit</button>
    </form>

    <script>
    document.getElementById('title').focus();
    </script>
    ${components.render_upload_form()}`
}

components.comment_pagination = function (comments, current_url, u=url) { // get pagination links for a single page of comments
    if (!comments || !current_url || (util.intval(comments.found_rows) <= 40)) return // no pagination links needed if one page or less

    let total    = comments.found_rows
    let pathname = u.parse(current_url).pathname // "pathname" is current_url path without the ? parms, unlike "path"
    let query    = u.parse(current_url).query

    if (!query || !query.match(/offset=\d+/)) { // offset missing means we are on the last page of comments, ie offset = total - 40
        var offset          = total - 40
        let previous_offset = (total - 80 > 0) ? total - 80 : 0 // second to last page
        let q               = query ? (query + '&') : ''

        var first_link = `${pathname}?${q}offset=0#comments`
        var prev_link  = `${pathname}?${q}offset=${previous_offset}#comments`
        var last_link  = `${pathname}${query ? ('?' + query) : ''}#last` // don't include the question mark unless q
        // there is no next_link because we are necessarily on the last page of comments
    }
    else { // there is a query string, and it includes offset; 0 means show first 40 comments
        var offset          = util.intval(util._GET(current_url, 'offset'))

        if (offset !== 0) { // don't need these links if we are on the first page
            let previous_offset = (offset - 40 > 0) ? offset - 40 : 0
            var first_link      = `${pathname}?${query.replace(/offset=\d+/, 'offset=0')}#comments`
            var prev_link       = `${pathname}?${query.replace(/offset=\d+/, 'offset=' + previous_offset)}#comments`
        }

        if (offset < total - 40) { // no next link on last page
            let next_offset = (offset + 40 > total - 40) ? total - 40 : offset + 40 // last page will always have 40 comments
            if (total > 40 && total < 80) { // edge case where there is overlap in comments between first and second pages
                let comment_id  = comments[39].comment_id
                var next_link   = `${pathname}?${query.replace(/offset=\d+/, 'offset=' + next_offset)}#comment-${comment_id}`
            }
            else {
                var next_link   = `${pathname}?${query.replace(/offset=\d+/, 'offset=' + next_offset)}#comments`
            }
        }
        var last_link = `${pathname}?${query.replace(/offset=\d+/, 'offset=' + (total - 40))}#last`
    }

    let ret = `<p id='comments'>`
    if (typeof first_link !== 'undefined') ret = ret + `<a href='${first_link}' title='Jump to first comment'     >&laquo; First</a>    &nbsp; &nbsp;`
    if (typeof prev_link  !== 'undefined') ret = ret + `<a href='${prev_link}'  title='Previous page of comments' >&laquo; Previous</a> &nbsp; &nbsp;`

    let max_on_this_page = (total > offset + 40) ? offset + 40 : total
    ret = ret + `Comments ${offset + 1} - ${max_on_this_page} of ${total.number_format()} &nbsp; &nbsp;`

    if (typeof next_link  !== 'undefined') ret = ret + `<a href='${next_link}'  title='Next page of comments' >Next &raquo;</a> &nbsp; &nbsp;`

    return ret + `<a href='${last_link}' title='Jump to last comment' >Last &raquo;</a></br>`
}

components.name_email_input = function() { // where users enter the username and email address to register, whether on comment or reg page
    return `
        <div class='form-group'><input type='text'  name='user_name'  placeholder='choose username' class='form-control' id='user_name' ></div>
        <div class='form-group'><input type='email' name='user_email' placeholder='email'           class='form-control'                ></div>
    `
}

components.maybe_name_email_input = function(context) {
    return context.current_user ? '' : components.name_email_input()
}

components.comment_box = function(post, context) { // add new comment, just updates page without reload

    const current_user = context.current_user
    const ip           = context.ip

    let url = `/accept_comment?${util.create_nonce_parms(context)}` // first href on button below is needed for mocha test
    return `
    <hr>
    ${components.render_upload_form()}
    <form id='commentform' >
        <textarea id='ta' name='comment_content' class='form-control' rows='10' ></textarea><p>
        <input type='hidden' name='comment_post_id' value='${post.post_id}' />
        ${components.maybe_name_email_input(context)}
        <button class='btn btn-success btn-sm' id='accept_comment' href=${url} 
            onclick="$.post('${url}', $('#commentform').serialize()).done(function(response_string) {
                var get_parms = {}
                location.search.substr(1).split('&').forEach(function(item) { get_parms[item.split('=')[0]] = item.split('=')[1] })

                if (get_parms['offset']) { // if url includes offset, then we are not on last page of comments, so redirect to last page
                    window.location = window.location.pathname + '#last'
                }
                else { // no offset, so we are on the last page of comments; just append
                    var response = JSON.parse(response_string) // was a string, now is an object
                    broadcast({id: 'comment_list', action: 'append', content: response.content, pathname: window.location.pathname});
                    if (!response.err) document.getElementById('commentform').reset() // don't clear the textbox if error
                }
            }).fail(function() {
                $('#comment_list').append('<p>Failed to post. Are you still connected to the internet?</p>')
            })
            return false" >submit</button>
    </form>`
}

components.id_box = function(current_user) {

    var img = components.render_user_icon(current_user, 0.4, `'align='left' hspace='5' vspace='2'`) // scale image down

    return `
        <div id='status' >
            ${img}<a href='/user/${current_user.user_name}' >${current_user.user_name}</a>
        </div>`
}

components.loginprompt = function() {
    return `
        <div id='status' >
            <form id='loginform' action='/post_login' method='post'>
                <fieldset>
                    <input id='email'    name='email'    placeholder='email'    type='text'     required >
                    <input id='password' name='password' placeholder='password' type='password' required >
                </fieldset>
                <fieldset>
                    <input type='submit' id='submit' value='log in' >
                    <a href='#' onclick="midpage.innerHTML = lostpwform.innerHTML;  return false" >forgot password</a> /
                    <a href='#' onclick="midpage.innerHTML = registerform.innerHTML; return false" >register</a>
                </fieldset>
            </form>
            <div style='display: none;' >
                ${ lostpwform()   }
                ${ registerform() }
            </div>
        </div>`
}

function lostpwform() {
    return `
    <div id='lostpwform' >
        <h1>reset password</h1>
        <form action='/recoveryemail' method='post'>
            <div class='form-group'><input type='email' name='user_email' placeholder='email address' class='form-control' id='lost_pw_email' ></div>
            <button type='submit' id='submit' class='btn btn-success btn-sm'>submit</button>
        </form>
        <script>document.getElementById('lost_pw_email').focus();</script>
    </div>`
}

function registerform() {
    return `
    <div id='registerform' >
        <h1>register</h1>
        ${components.name_email_form('register')}
    </div>`
}

components.name_email_form = function(button_text) { // button_text is used both for the button, and for the route to call when the button is clicked
    return `
    <form action='/${button_text}' method='post'>
        <div >
            ${ components.name_email_input() }
        </div>
        <button type='submit' id='submit' class='btn btn-success btn-sm'>${button_text}</button>
    </form>
    <script>document.getElementById('user_name').focus();</script>`
}

components.icon_or_loginprompt = function(current_user) {
    if (current_user) return components.id_box(current_user)
    else              return components.loginprompt()
}

components.popup = function(message) {
    return `<script>alert('${ message }');</script>`
}

components.new_post_button = function(current_user, c=conf) {
    if (permissions.may_create_post(current_user))
        return `<a href="/new_post" class="btn btn-success btn-sm" title="start a new post" ><b>${c.new_post_button_text}</b></a>`
    else
        return ``
}

components.subscribe_button = function() {
    return `<a href="/housing_news" class="btn btn-primary btn-sm" title="housing news" ><b>housing news</b></a>`
}

components.midpage = function(...args) { // just an id so we can easily swap out the middle of the page
    return `<div id="midpage" >
        ${ args.join('') }
        </div>`
}

components.share_post = function(post, c=conf) {
    let share_title = encodeURI(post.post_title).replace(/%20/g,' ')
    let share_link  = encodeURI('https://' + c.domain +  util.post2path(post) )
    return `<a href='mailto:?subject=${share_title}&body=${share_link}' title='email this' >share
            <img src='/icons/mailicon.jpg' width=15 height=12 ></a>`
}

components.nsfw = function(post, nonce_parms) {
    return `<a href='#' id='nsfw' onclick="$.get('/nsfw?p=${post.post_id}&${nonce_parms}', function(data) {
        document.getElementById('nsfw').innerHTML = data; });
        return false" title='image not suitable for work'>${post.post_nsfw ? 'nsfw' : 'sfw'}</a>`
}

components.watcheye = function(post, nonce_parms) {
    return `<a href='#' id='watch' onclick="$.get('/watch?post_id=${post.post_id}&${nonce_parms}', function(data) {
        document.getElementById('watch').innerHTML = data; });
        return false" title='comments by email'>${components.render_watch_indicator(post.postview_want_email)}</a>`
}

components.render_watch_indicator = function (want_email) {
    return want_email ? `<img src='/icons/openeye.png' > unwatch` : `<img src='/icons/closedeye.png' > watch`
}

components.format_post = function(post, context) { // format a single post for display

    let ip            = context.ip
    let current_user  = context.current_user
    let arrowbox_html = components.arrowbox(post, context.current_user)
    let icon          = components.render_user_icon(post, 1, `align='left' hspace='5' vspace='2'`)
    let link          = components.post_link(post)
    let nonce_parms   = util.create_nonce_parms(context)

    // edit permission same as delete permission
    let edit_link = permissions.may_delete_post(post, context.current_user) ?  `<a href='/edit_post?p=${post.post_id}&${nonce_parms}'>edit</a> ` : ''

    let delete_link = permissions.may_delete_post(post, context.current_user) ?
        `<a href='/delete_post?post_id=${post.post_id}&${nonce_parms}' onClick="return confirm('Really delete?')" id='delete_post' >delete</a> ` : ''

    post.user_name = post.user_name || 'anonymous' // so we don't display 'null' in case the post is anonymous

    var utz = current_user ? current_user.user_timezone : 'America/Los_Angeles'

    return `<div class='comment' >${arrowbox_html} ${icon} <h2 style='display:inline' >${ link }</h2>
            <p>By ${components.user_link(post)} ${components.follow_user_button(post, context)} &nbsp; ${util.render_date(post.post_date, utz)}
            ${post.post_views.number_format()} views &nbsp; ${post.post_comments.number_format()} comments &nbsp;
            ${components.watcheye(post, nonce_parms)} &nbsp;
            ${components.nsfw(post, nonce_parms)} &nbsp;
            <a href="#commentform" onclick="addquote( '${post.post_id}', '0', '0', '${post.user_name}' ); return false;"
               title="Select some text then click this to quote" >quote</a> &nbsp;
            &nbsp; ${components.share_post(post)} &nbsp; ${edit_link} &nbsp; ${delete_link}
            <p><hr><div class="entry" class="alt" id="comment-0-text" >${ post.post_content }</div></div>`
}

components.user_link = function(u) {
    return `<a href='/user/${ u.user_name }' id='user_link' >${ u.user_name }</a>`
}

components.follow_user_button = function(u, context) { // u is the user to follow, a row from users table

    const current_user = context.current_user
    const ip           = context.ip

    let b = `<button type="button" class="btn btn-default btn-xs" title="get emails of new posts by ${u.user_name}" >follow ${u.user_name}</button>`

    var unfollow_user_link = `<span id='unfollow_user_link' >following<sup>
                         <a href='#' onclick="$.get('/follow_user?other_id=${u.user_id}&undo=1&${util.create_nonce_parms(context)}&ajax=1',
                         function() { document.getElementById('follow').innerHTML = document.getElementById('follow_user_link').innerHTML }); return false" >x</a></sup></span>`

    var follow_user_link = `<span id='follow_user_link' >
                       <a href='#' title='hide all posts and comments by ${u.user_name}'
                       onclick="$.get('/follow_user?other_id=${u.user_id}&${util.create_nonce_parms(context)}&ajax=1',
                       function() { document.getElementById('follow').innerHTML = document.getElementById('unfollow_user_link').innerHTML }); return false" >${b}</a></span>`

    if (current_user
     && current_user.relationships
     && current_user.relationships[u.user_id]
     && current_user.relationships[u.user_id].rel_i_follow) {
        var follow = `<span id='follow' >${unfollow_user_link}</span>`
    }
    else {
        var follow = `<span id='follow' >${follow_user_link}</span>`
    }

    return `<span style='display: none;' > ${follow_user_link} ${unfollow_user_link} </span> ${follow}`
}

components.render_user_info = function(u, context) {
    const current_user = context.current_user
    const img          = components.render_user_icon(u)
    const ip           = context.ip

    const edit_or_logout = (current_user && u.user_id === current_user.user_id) ?
        `
        <div style='float:right'>
            <a href='/edit_profile'>edit profile</a> &nbsp;
            <a href='/logout' >logout</a>
        </div>
        <div style='clear: both;'></div>
        ` : ''

    const unignore_link = `<span id='unignore_link' >ignoring ${u.user_name}<sup>
                         <a href='#' onclick="$.get('/ignore?other_id=${u.user_id}&undo=1&${util.create_nonce_parms(context)}',
        function() { document.getElementById('ignore').innerHTML = document.getElementById('ignore_link').innerHTML }); return false" >x</a></sup></span>`

    const ignore_link = `<span id='ignore_link' >
                       <a href='#' title='hide all posts and comments by ${u.user_name}'
                       onclick="$.get('/ignore?other_id=${u.user_id}&${util.create_nonce_parms(context)}',
        function() { document.getElementById('ignore').innerHTML = document.getElementById('unignore_link').innerHTML }); return false" >ignore</a></span>`

    if (current_user
     && current_user.relationships
     && current_user.relationships[u.user_id]
     && current_user.relationships[u.user_id].rel_i_ban) {
        var ignore = `<span id='ignore' >${unignore_link}</span>`
    }
    else var ignore = `<span id='ignore' >${ignore_link}</span>`

    return `${edit_or_logout}
            <center><a href='/user/${u.user_name}' >${ img }</a><h2>${u.user_name}</h2>
                ${u.user_aboutyou || ''}
                <p>joined ${ util.render_date(u.user_registered) } &nbsp;
                ${u.user_country ? u.user_country : ''}
                ${u.user_posts.number_format()} posts &nbsp;
                <a href='/comments?a=${encodeURI(u.user_name)}'>${ u.user_comments.number_format() } comments</a> &nbsp;
                ${components.follow_user_button(u, context)} &nbsp;
                <span style='display: none;' > ${ignore_link} ${unignore_link} </span>${ignore}
                <p>
            </center>`
}

components.profile_form = function(updated, context) {

    let u = context.current_user
    if (!u) return die('please log in to edit your profile', context)

    let timezones = {}
    timezones['America/Los_Angeles'] = 'Pacific'
    timezones['America/Denver']      = 'Mountain'
    timezones['America/Chicago']     = 'Central'
    timezones['America/New_York']    = 'Eastern'

    let message = updated ? `<h3><font color='green'>your profile has been updated</font></h3>` : ''
    let ret = `<h1>edit profile</h1>${message}
    <table>
    <tr>
    <td>${components.render_user_icon(u)} &nbsp; </td>
    <td>
        <div style='margin: 0px; padding: 5px; border: 1px solid #ddd; background-color: #f5f5f5; display: inline-block;' >
            <form enctype='multipart/form-data' id='upload-file' method='post' action='upload'>
                Upload any size image to represent you (gif, jpg, png, bmp)<br>
                Image will automatically be resized after upload<p>
                <input type='file'   id='upload' name='image' class='form' />
                <input type='submit' value='Upload &raquo;' class='form' />
            </form>
        </div>
    </td></tr></table><p>
    <form name='profile' action='update_profile?${util.create_nonce_parms(context)}' method='post'>
    <input type='text'  name='user_name'  placeholder='user_name' size='25' value='${ u.user_name }'  maxlength='30'  /> user name<p>
    <input type='email' name='user_email' placeholder='email'     size='25' value='${ u.user_email }' maxlength='100' /> email<p>
    Your timezone is ${timezones[u.user_timezone]}
    <select name='user_timezone'>
        <option value='' disabled='disabled' selected='selected'>change timezone</option>
        <option value='0'>Pacific</option>
        <option value='1'>Mountain</option>
        <option value='2'>Central</option>
        <option value='3'>Eastern</option>
    </select>
    <p>
    <input type='checkbox' name='user_summonable' value='1' ${ u.user_summonable ? 'checked' : '' } >
        Get emails of comments which have '@${ u.user_name }' and get emails of 'likes' of your comments <br>
    <input type='checkbox' name='user_hide_post_list_photos' value='1' ${ u.user_hide_post_list_photos ? 'checked' : '' } >Hide images on post lists
    <h2>about you</h2>
    <textarea class='form-control' rows='3' name='user_aboutyou' >${u.user_aboutyou || ''}</textarea><br>
    <input type='submit' class='btn btn-success btn-sm' value='Save' />
    </form>
    <p>
    <h3>ignored users</h3>(click to unignore that user)<br>`

    let ignored_users = u.relationships ? u.relationships.filter(rel => rel).filter(rel => rel.rel_i_ban) : null
    
    if (ignored_users && ignored_users.length)
        ret += ignored_users.map(u => `<a href='#' onclick="$.get('/ignore?other_id=${u.user_id}&undo=1&${util.create_nonce_parms(context)}',
         function() { $('#user-${ u.user_id }').remove() }); return false" id='user-${u.user_id}' >${u.user_name}</a><br>`).join('')
    else
        ret += 'none'

    return ret
}

components.brag = function(header_data) {

    const online_list = header_data.onlines.map(u => `<a href='/user/${u.online_username}'>${u.online_username}</a>`).join(', ')

    return `${ header_data.comments.number_format() } comments by
            ${ header_data.tot.number_format() } users
            ${ online_list } ${online_list.length ? 'and' : ''} ${ header_data.lurkers } lurker${ header_data.lurkers === 1 ? '' : 's'} online now`
}

components.tabs = function(order, extra='', path) {

    if (!path) return

    let selected_tab = []
    selected_tab['active']   = ''
    selected_tab['comments'] = ''
    selected_tab['likes']    = ''
    selected_tab['new']      = ''
    selected_tab[order]      = `class='active'` // default is active

    return `<ul class='nav nav-tabs'>
        <li ${selected_tab['active']}   > <a href='${path}?order=active${extra}'   title='most recent comments'       >active</a></li>
        <li ${selected_tab['comments']} > <a href='${path}?order=comments${extra}' title='most comments in last week' >comments</a></li>
        <li ${selected_tab['likes']}    > <a href='${path}?order=likes${extra}'    title='most likes in last week'    >likes</a></li>
        <li ${selected_tab['new']}      > <a href='${path}?order=new${extra}'      title='newest'                     >new</a></li>
        </ul>`
}

components.admin_user = function(u, context) { // links to administer a user

    const current_user = context.current_user
    const ip           = context.ip

    if (!current_user)                                 return ``
    if (current_user && current_user.user_level !== 4) return ``

    return `<hr>
        <a href='https://whatismyipaddress.com/ip/${u.user_last_comment_ip}'>geolocate</a> &nbsp;
        <a href='/user/${u.user_name}?become=1&${util.create_nonce_parms(context)}' >become ${u.user_name}</a> &nbsp;
        <a href='/nuke?nuke_id=${u.user_id}&${util.create_nonce_parms(context)}' onClick='return confirm("Really?")' >nuke</a> &nbsp;
        <hr>`
}

components.prev_next = function(prev, next) {
    let prev_link = prev ? `&laquo; <a href='/post/${prev}'>prev</a>  &nbsp;` : ''
    let next_link = next ? `&nbsp;  <a href='/post/${next}'>next</a> &raquo;` : ''

    return `<b>${prev_link} <a href='/random' title='take me to a random post' >random</a> ${next_link}</b>`
}

components.client_side_js = function() {
    return `<script>
    function addquote(post_id, offset, comment_id, author) {
        var textarea = document.forms['commentform'].elements['ta'];
        var theSelection = '';

        if (comment_id > 0) var comment_link = '<a href="/post/' + post_id + '&offset=' + offset + '#comment-' + comment_id + '">' + author + ' says</a>';
        else                var comment_link = '<a href="/post/' + post_id                                                  + '">' + author + ' says</a>';

        theSelection = getHTMLOfSelection(); // user manually selected something
        if (!theSelection) theSelection = document.getElementById('comment-' + comment_id + '-text').innerHTML; // else take the whole comment

        // either we are on mobile (no selection possible) or the user did not select any text; whole comment, or post when comment_id === 0
        if (theSelection.length > 1024) var theSelection = theSelection.substring(0, 1000) + '...'; // might mangle tags
        textarea.value = textarea.value + comment_link + '<br><blockquote>' + theSelection + '</blockquote>';
        textarea.focus();
        return;
    }

    function getHTMLOfSelection () {
        if (!window.getSelection) return '';
        var selection = window.getSelection();
        if (selection.rangeCount <= 0) return ''
        var range = selection.getRangeAt(0);
        var clonedSelection = range.cloneContents();
        var div = document.createElement('div');
        div.appendChild(clonedSelection);
        return div.innerHTML;
    }
    </script>`
}

components.timings = function(context) { // leaf component, takes only data, no subcomponents
    let db_total_ms = 0
    let queries = context.cxn.queries

    queries = queries.sortByProp('ms').map(item => {
        db_total_ms += item.ms
        return `${ item.ms }ms ${ item.sql }`
    }).join('\n')

    return `<!--
        ${queries}
        ${db_total_ms} ms db time
        ${Date.now() - context.start_time} ms total time -->`
}

components.comment_search_box = function() {
    return `<form name='searchform' action='/comments' method='get' id='comment_search_box' > 
      <fieldset> 
      <input type='text'   name='s'      value='' size='17' /> 
      <input type='hidden' name='offset' value='0' /> 
      <input type='submit'               value='Search comments &raquo;' />  
      </fieldset> 
    </form>`
}

components.like_dislike = function() {
    return `
    <script id='like_dislike' >
        function like(content) {
            $.get( "/like?comment_id="+content.split("_")[1], function(data) { document.getElementById(content).innerHTML = data; });
        }
        function dislike(content) {
            $.get( "/dislike?comment_id="+content.split("_")[1], function(data) { document.getElementById(content).innerHTML = data; });
        }
        function postlike(content) { // For whole post instead of just one comment.
            $.get( "/like?post_id="+content.split("_")[1]+"_up", function(data) { document.getElementById(content).innerHTML = data; });
        }
        function postdislike(content) { // For whole post instead of just one comment.
            $.get( "/dislike?post_id="+content.split("_")[1]+"_down", function(data) { document.getElementById(content).innerHTML = data; });
        }
    </script>`
}

components.nav = function() { // navigation widget fixed to lower right corner of screen; really useful on mobile
    return `
    <div class='fixed' id='nav' >
        <a href='#'       title='top of page' >top</a> &nbsp;
        <a href='#footer' title='bottom of page' >bottom</a> &nbsp;
        <a href='/'       title='home page' >home</a>
    </div>
    `
}

components.footer = function(admin_email) {
    const wsurl = ('dev' === process.env.environment) ? `ws://dev.${conf.domain}/websocket/` : `wss://${conf.domain}/websocket/` // prod is ssl (wss), dev is not (ws)

    return `
    <p id='footer' >
    <hr>
    <a href='http://www.amazon.com/Housing-Trap-Buyers-Captured-Yourself/dp/1479156213/?tag=patricknet-20'><br>
    <img src='/uploads/2018/03/1_bookcover.jpg' width='189' height='298' align='left' style='margin: 10px' ></a><br>
    <a href='http://www.amazon.com/Housing-Trap-Buyers-Captured-Yourself/dp/1479156213/?tag=patricknet-20'><b>The Housing Trap</b></a><br>
    You're being set up to spend your life paying off a debt you don't need to take on, for a house that costs far more than it should. The
    conspirators are all around you, smiling to lure you in, carefully choosing their words and watching your reactions as they push your buttons,
    anxiously waiting for the moment when you sign the papers that will trap you and guarantee their payoff. Don't be just another victim of the
    housing market. Use this book to defend your freedom and defeat their schemes. You can win the game, but first you have to learn how to play
    it.<br>
    <a href='http://www.amazon.com/Housing-Trap-Buyers-Captured-Yourself/dp/1479156213/?tag=patricknet-20'>115 pages, $12.50<br><br>Kindle version available</a>
    <div ><hr>
        <center>
            <form method='get' action='/search' ><input name='s' type='text' placeholder='search...' size='20' ></form>
            <br>
            <a href='/about'>about</a> &nbsp;
            <a href='/best'>best comments</a> &nbsp;
            <a href='mailto:${ admin_email }' >contact</a> &nbsp;
            <a href='/old?years_ago=1'>one year ago</a> &nbsp;
            <a href='/post/1210872'>suggestions</a> &nbsp;
            <p>
        </center>
        <style> body { padding-bottom: 40px; } </style>
        ${components.nav()}
        ${components.like_dislike()}
        <script>console.log('Suggestions for Patrick? Write p@patrick.net')</script>
    </div>

    <script>
        var socket
        var opens = 0

        function update_dom(message) {
            $('#' + message.id)[message.action](message.content);
        }

        window.onload = open_ws

        function open_ws() {
            socket = new WebSocket('${wsurl}')
            opens++
            console.log('websocket ' + opens + ' opened at ' + Date())

            socket.onmessage = function (msg) {
                update_dom(JSON.parse(msg.data));
            }

            socket.onopen = function () {
                socket.send(
                    JSON.stringify({
                        action   : 'subscribe',
                        pathname : window.location.pathname,
                    })
                )
            }

            socket.onclose = function () {
                console.log('websocket ' + opens + ' closed at ' + Date())
                if (opens < 3) setTimeout(open_ws, 2000) // wait two seconds before trying to re-open; try a max of 3 times
            }
        }

        function broadcast(message) {
            update_dom(message); // do update locally first so it will still work even if websocket is down
            socket.send(JSON.stringify(message));
        }

        setInterval(function () {
            socket.send(JSON.stringify({ action : 'ping' }));
        }, 30000) // send pings every 30s because nginx will time out inactive connections after one minute

    </script>`
}

components.post_pagination = function(post_count, curpage, extra, current_url, u=url) {

    if (!current_url) return

    let links    = `<span id='post_pagination'>`
    let nextpage = curpage + 1
    let pages    = Math.floor( (post_count + 20) / 20)
    let path     = u.parse(current_url).pathname
    let prevpage = curpage - 1

    if (curpage > 1) links = links + `<a href='${path}?page=${prevpage}${extra}'>&laquo; previous</a> &nbsp;`

    links = links + ` page ${curpage} of ${pages} `

    if (curpage < pages) links = links + `&nbsp; <a href='${path}?page=${nextpage}${extra}'>next &raquo;</a>`

    links = links + '</span>'

    return links
}

components.h1 = function(message) {
    return `<h1 style='display: inline;' id='h1' >${ message }</h1>`
}

components.h2 = function(message) {
    return `<h2 style='display: inline;' id='h2' >${ message }</h2>`
}

components.header = function(context, c=conf) {

    const current_user = context.current_user
    const header_data  = context.header_data

    return `<div class='comment' id='header' >
        <div style='float:right' >${ components.icon_or_loginprompt(current_user) }</div>
        <a href='/' ><h1 class='sitename' title='back to home page' >${ c.domain }</h1></a>
        <br>
        <a href='/post/${ c.about_post_id }'>${ c.description }</a><br>${ components.brag(header_data) }</font><br>
        ${ components.new_post_button(current_user) }
        </div>`
}

components.head = function(conf, context) {
    const stylesheet = conf.stylesheet
    const description = conf.description
    const title = context.post ? context.post.post_title : conf.domain

    return `<head>
    <link href='/${ stylesheet }' rel='stylesheet' type='text/css' />
    <link rel='icon' href='/favicon.ico' />
    <meta ad='Suggestions for Patrick? Write p@patrick.net' />
    <meta charset='utf-8' />
    <meta name='keywords'    content='forum software' />
    <meta name='description' content='${ description }' />
    <meta name='viewport'    content='width=device-width, initial-scale=1, shrink-to-fit=no' />
    <title>${ title }</title>
    ${components.client_side_js()}
    </head>`
}

components.body = function(...args) {
    return `
    <body>
        <div class='container' >
        ${ args.join('') }
        </div>
    </body>`
}

components.html = function(...args) {
    return `<!DOCTYPE html>
    <html lang='en'>
        ${ args.join('') }
        <script async src='/jquery.min.js'></script>
    </html>`
}
