// Copyright 2015 authors shown at
// https://github.com/nrc/rust-triage/graphs/contributors.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

// Code for producing the digest email.

var call = require('./call.js');

var issue_url = "";

exports.make_digest = function(data, config, callback) {
    data = sort_data(data);
    issue_url = "https://github.com/" + config.owner + "/" + config.repo + "/issues/";

    // Get a list of nominated issues and put them first in the email
    call.issues_for_label("I-nominated", config, function(err, json) {
        if (err) {
            console.log("Error fetching nominated issues:", err);
        }

        var result = "";
        result += "<h2>Nominated issues</h2>\n\n";
        var skip_list = [];

        // Nominated issues.
        for (var i in json) {
            var issue = json[i];
            var number = issue['number'];
            result += emit_issue(number, issue['title']);
            var related = data.filter(function(i) { return i.issue_number == number; });
            if (related.length > 0) {
                result += "<ul>\n"
                related.map(function(datum) {
                    if (is_admin_issue(datum)) {
                        // Skip admin issues, we'll get to them later.
                        return;
                    }

                    result += emit_action(datum);
                });
                result += "</ul>\n"                
            }

            skip_list.push(number);
        }

        result += "<h2>Remaining issues</h2>\n\n";

        // Rest of the email
        var cur_issue = "0";
        var needs_close = false;
        data.map(function(datum) {
            if (skip_list.indexOf(datum.issue_number) >= 0 ||
                is_admin_issue(datum)) {
                // Skip nominated issues (we did them earlier) and admin issues, we'll get to them later.
                return;
            }
            if (datum.issue_number != cur_issue) {
                if (needs_close) {
                    result += "</ul>\n"
                }
                cur_issue = datum.issue_number;
                result += emit_issue(cur_issue, datum.issue_title);
                result += "<ul>\n"
                needs_close = true;
            }

            result += emit_action(datum);
        });
        if (needs_close) {
            result += "</ul>\n"
        }

        // Admin issues.
        var make_admin_title = true;
        data.map(function(datum) {
            if (!is_admin_issue(datum)) {
                // Skip non-admin issues.
                return;
            }

            if (make_admin_title) {
                make_admin_title = false;
                result += "\n<h2>Admin issues</h2>\n\n<ul>\n";
            }

            result += emit_action(datum,
                                  "on issue " + issue_link(datum.issue_number, datum.issue_title));
        });
        if (!make_admin_title) {
            result += "</ul>\n"
        }

        callback(result);
    });
}

function is_admin_issue(datum) {
    return datum.action != "add" && datum.action != "remove";
}

function emit_issue(number, title) {
    var result = "\n<h3>";
    result += issue_link(number, title);
    result += "</h3>\n\n";
    return result;
}

function issue_link(number, title) {
    var result = "<a href=\"";
    result += issue_url;
    result += number;
    result += "\">";
    result += title;
    result += " (#";
    result += number;
    result += ")";
    result += "</a>";
    return result;    
}

function emit_action(datum, extra) {
    var action = datum.action;
    var label = datum.label;
    var milestone = datum.milestone;
    var user = datum.user;
    var comment = datum.comment;

    var result = "<li>";
    if (action == "add") {
        result += "Added <b>";
    } else if (action == "remove") {
        result += "Removed ";
    } else {
        result += action + ": ";
    }
    result += label;
    if (action == "add") {
        result += "</b>";
    }
    if (milestone && milestone != "") {
        result += ". Set milestone: <b>" + milestone + "</b>"
    }
    result += ". By @";
    result += user;
    if (extra) {
        result += " ";
        result += extra;
    }
    if (comment) {
        result += "\n<p>" + comment + "</p>";
    }
    result += "</li>\n";
    return result;
}

// Sort the data by issue.
function sort_data(data) {
    // We want a stable sort because for each issue, we wish to preserve the
    // ordering by time of the changes.
    var sort_map = data.map(function(e, i) {
        return {
            "index": i,
            // This assumes we have < 100000 data items in out list, that seems reasonable.
            "value": parseInt(e.issue_number, 10) * 100000 + i
        }
    });
    sort_map.sort(function(a, b) { return a.value - b.value; });
    return sort_map.map(function(s) { return data[s.index]; } );
}
