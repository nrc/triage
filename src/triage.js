// Copyright 2015 authors shown at
// https://github.com/nrc/rust-triage/graphs/contributors.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

var async = require('async');
var path = require("path");
var fs = require('fs');
var http = require('http');
var url = require('url');
var nodemailer = require('nodemailer');

var call = require('./call.js');
var digest = require('./digest.js');

var triage_regex = /\btriage:? ?(I-nominated|I-needs-decision|beta-[a-zA-Z0-9\-]+|P-[a-zA-Z0-9\-]+)\b *(?:\(([a-zA-Z0-9\-\. ]*)\))?/;

// Currently saved data (list of priority changes).
var data = [];
// We've sent a priority update ourself, so can expect a label change hook imminently.
// Used as a hashset.
var pending = [];

var data_filename = "data.json";
var email_filename = "emails.json"
var config = require('./config.json');

// Entry point.
init();
start_server();

function init(config_filename) {
    // Load any saved data from the last run.
    var filename = path.resolve(__dirname, data_filename);
    data = JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function start_server() {
    console.log('starting server; listening on 2347')
    http.createServer(function (req, res) {
        var parsed_url = url.parse(req.url, true);
        var pathname = parsed_url.pathname;
        if (pathname == '/data') {
            // Dump data as JSON, primarily for debugging.
            res.writeHead(200, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"});
            res.end(JSON.stringify(data));
        } else if (pathname == '/hook') {
            // Accept webhooks from GitHub
            combine_chunks(req, function(body) {
                try {
                    var json = JSON.parse(body);
                    var event = req.headers["x-github-event"]
                    var output = "Nope, unrecognised event: " + event;
                    if (event == "issues") {
                        output = process_issue(json);
                    } else if (event == "issue_comment") {
                        output = process_comment(json);
                    }
                    res.writeHead(200, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
                    res.end("Success?\n\n" + output);
                } catch (e) {
                    res.writeHead(200, {"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"});
                    res.end("Error: " + e);
                }
            });
        } else if (pathname == '/mail_digest') {
            produce_digest(function(output) {
                res.writeHead(200, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
                res.end(output);
            });
        } else if (pathname == '/preview_digest') {
            preview_digest(function(output) {
                res.writeHead(200, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
                res.end(output);
            });
        } else if (pathname == '/digest') {
            var output = show_digest(parsed_url.query['date']);
            res.writeHead(200, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
            res.end(output);
        } else if (pathname == '/list') {
            var output = list_digests(parsed_url.query['date']);
            res.writeHead(200, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
            res.end(output);
        } else {
            res.writeHead(404, {"Content-Type": "text/plain"});
            res.write("404 Not Found\n");
            res.end();
          }
    }).listen(2347);
}

function combine_chunks(req, callback) {
    var body = '';
    req.on('data', function(chunk) {
        body += chunk;
    });
    req.on('end', function() {
        callback(body);
    });
}

// Process issue hook, we are looking for label changes or new issue with label/comment.
function process_issue(body) {
    if (!sanity_check(body.repository.owner.login, body.repository.name)) {
        return "Nope, wrong repo"
    }

    if (body.action == "opened") {
        // Commit comment.
        added_comment(body.issue.number,
                      body.issue.title,
                      body.issue.body,
                      body.sender.login,
                      body.issue.labels);
        // Labels.
        body.issue.labels.map(function(label) {
            added_label(body.issue.number,
                        body.issue.title,
                        body.label.name,
                        body.sender.login);
        });
        save_data();
        return "processed new issue"
    } else if (body.action == "labeled") {
        added_label(body.issue.number,
                    body.issue.title,
                    body.label.name,
                    body.sender.login);
        save_data();
        return "added label";
    } else if (body.action == "unlabeled") {
        removed_label(body.issue.number,
                      body.issue.title,
                      body.label.name,
                      body.sender.login);
        save_data();
        return "removed label";
    } else {
        return "Nope, unhandled action: " + body.action;
    }
}

// Process either comment or issue hooks.
// Process comment hook, we are looking for instructions to change the priority.
function process_comment(body) {
    if (!sanity_check(body.repository.owner.login, body.repository.name)) {
        return "Nope, wrong repo"
    }

    if (body.action == "created") {
        added_comment(body.issue.number,
                      body.issue.title,
                      body.comment.body,
                      body.sender.login,
                      body.issue.labels);
        save_data();
        return "processed new comment"
    } else {
        return "Nope, unhandled action: " + body.action;
    }

    return JSON.stringify(body);
}

function added_comment(issue_number, issue_title, comment, user, issue_labels) {
    var match = triage_regex.exec(comment);
    if (match && match[1]) {
        console.log("Matched comment:", comment);
        var priority = match[1];
        var milestone = "";
        if (match[2]) {
            milestone = match[2];
        }

        var record = {
            "action": "add",
            "issue_number": issue_number,
            "issue_title": issue_title,
            "label": priority,
            "milestone": milestone,
            "user": user,
            "comment": comment
        };

        // Check the user.
        if (config.triagers.indexOf(user) < 0) {
            console.log("bad access by", user);
            record.action = "bad access";
            record.comment += "\n[match: " + match.toString() + "]"
            data.push(record);
            return;
        }

        // Set the priority on the issue and record the changes.
        //   remove any existing priorities.
        async.map(issue_labels, function(label, callback) {
            // The is_prioirty check is so that checking the beta- status does
            // not affect the priority.
            if (is_priority(priority)) {
                console.log("maybe removing label");
                if (is_priority(label.name)) {
                    // Send request to GH to remove label.
                    call.remove_label(issue_number, label.name, config, callback);

                    // Don't need to record it, we'll get the GH hooks for it later.
                } else {
                    callback(null, null);
                }
            }
        }, function(err, results) {
            if (err) {
                console.log("Error removing labels:", err);
            }
            console.log("Set new priority", priority, milestone);

            // Once we're done removing labels, carry on setting the milestone
            // and so forth.

            if (milestone) {
                call.set_milestone(issue_number, milestone, config);
            }

            // Add the new label, record in pending and data.
            pending[issue_number + priority] = true;
            data.push(record);

            call.add_label(issue_number, priority, config);
        });
    }
}

function added_label(issue_number, issue_title, label, user) {
    if (!is_priority(label) && !is_beta(label)) {
        return;
    }

    // Check if record is in pending. If so, remove from pending and don't add
    // to data.
    if (pending[issue_number + label]) {
        pending[issue_number + label] = false;
        return;
    }

    var record = {
        "action": "add",
        "issue_number": issue_number,
        "issue_title": issue_title,
        "label": label,
        "milestone": "",
        "user": user,
        "comment": ""
    };
    data.push(record);
}

function removed_label(issue_number, issue_title, label, user) {
    if (!is_priority(label) && !is_beta(label)) {
        return;
    }

    var record = {
        "action": "remove",
        "issue_number": issue_number,
        "issue_title": issue_title,
        "label": label,
        "milestone": "",
        "user": user,
        "comment": ""
    };

    data.push(record);
}


// Check we have a hook from the right repo.
function sanity_check(owner, repo) {
    return owner == config.owner && repo == config.repo;
}

// Does label represent a priority?
function is_priority(label) {
    return label.indexOf("P-") == 0 ||
           label == "I-nominated" ||
           label == "I-needs-decision";
}

function is_beta(label) {
    return label == "beta-accepted" ||
           label == "beta-nominated";
}

function save_data() {
    // Save data to temp file.
    var temp_filename = data_filename + ".tmp";
    fs.writeFileSync(path.resolve(__dirname, temp_filename), JSON.stringify(data));

    // Delete old data file.
    fs.unlinkSync(path.resolve(__dirname, data_filename));

    // Rename temp file to data file.
    fs.renameSync(path.resolve(__dirname, temp_filename),
                  path.resolve(__dirname, data_filename));
}

function preview_digest(callback) {
    digest.make_digest(data, config, callback);
}

function produce_digest(callback) {
    var cur_data = data;
    data = [];

    digest.make_digest(cur_data, config, function(html) {
        var date = new Date();
        var date_str = date.toISOString().replace(/[:\.]/g, "-");

        // Add a permalink
        html += "\n<p><a href=\"http://www.ncameron.org/triage/digest?date=" + date_str + "\">Permalink to this digest</a></p>"

        // Save the digest to a file.
        var digest_path = path.resolve(__dirname, "digests", date_str + ".html");
        fs.writeFileSync(digest_path, html);

        // Save the now empty data to file.
        save_data();

        // Send an email
        var addresses_filename = path.resolve(__dirname, email_filename);
        var addresses = JSON.parse(fs.readFileSync(addresses_filename, 'utf8'));

        var mail_transporter = nodemailer.createTransport({service: "Gmail",
                                                           auth: {
                                                             user: config["gmail user"],
                                                             pass: config["gmail password"]
                                                           }
                                                          });


        for (var a in addresses) {
            var addr = addresses[a];
            var email = {
                "from": "nrc@ncameron.org",
                "to": addr,
                "subject": "Triage digest",
                "html": html
            };

            mail_transporter.sendMail(email, function(err, info) {
                console.log("Sending to:", addr);
                console.log(err);
                console.log(info);
            });
        }

        mail_transporter.close();

        // Return the html so it can be displayed in the browser.
        callback(html);
    });
}


function show_digest(digest_date) {
    try {
        var digest_path = path.resolve(__dirname, "digests", digest_date + ".html");
        var body = fs.readFileSync(digest_path, 'utf8');

        var result = "<html>\n<head>\n<title>Triage digest: " + digest_date + "</title>\n</head>\n<body>\n";
        result += body;
        result += "\n</body>\n</html>\n";
        return result;
    } catch (err) {
        console.log("Error making digest for", digest_date);
        console.log(err);
        return "Error. Bad date?"
    }
}

function list_digests() {
    try {
        var dir_path = path.resolve(__dirname, "digests");
        var files = fs.readdirSync(dir_path);
        var body = "<ul>\n";
        for (i in files) {
            var file_name = files[i];
            var date = file_name.substring(0, file_name.length - 5);
            body += "<li><a href=\"http://www.ncameron.org/triage/digest?date=" + date + "\">" + date + "</a></li>\n";
        }

        var result = "<html>\n<head>\n<title>Triage digests" + "</title>\n</head>\n<body>\n";
        result += body;
        result += "</ul>\n</body>\n</html>\n";
        return result;
    } catch (err) {
        console.log("Error making digest for", digest_date);
        console.log(err);
        return "Error. Bad date?"
    }
}
