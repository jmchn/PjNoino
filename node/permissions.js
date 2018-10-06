'use strict'

const conf = require('./_conf.json') // _conf.json is required

let permissions = {}

exports = module.exports = permissions

permissions.may_create_post = function (current_user, c=conf) {
    if (!current_user) return false
    if (current_user.user_comments < 3) return false
    return current_user.user_level >= c.new_post_user_level
}

permissions.may_delete_comment = function (comment, current_user) {
    if (!current_user)                                                   return false
    if (current_user.user_level === 4)                                   return true  // site admin may delete any comment
    if (gt_week_old(comment.comment_date))                               return false // no one else may delete comments more than a week old
    if (current_user.user_id === comment.comment_author)                 return true  // you may delete your own comment if less than one week old
    return false
}

permissions.may_delete_post = function (post, current_user) {
    if (!current_user)                                             return false
    if (current_user.user_level === 4)                             return true  // site admin may delete any post
    if (gt_week_old(post.post_date))                               return false // no one else may delete posts more than a week old
    if (current_user.user_id === post.post_author)                 return true  // you may delete your own post if less than one week old
    if (current_user.user_level === 3 && post.post_approved === 0) return true  // moderator may delete posts less than one week old
    return false
}

permissions.may_mark_nsfw = function (current_user) {
    if (!current_user) return false
    return current_user.user_level >= 2
}

permissions.may_flag = function (current_user) {
    if (!current_user) return false
    return current_user.user_level >= 2
}

function gt_week_old(mysql_date) {
    const unixtime = new Date(mysql_date).getTime() // impure
    return (unixtime < Date.now() - 7 * 24 * 60 * 60 * 1000) ? true : false
}
