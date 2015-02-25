// Copyright 2015 authors shown at
// https://github.com/nick29581/rust-triage/graphs/contributors.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

var path = require("path");
var fs = require('fs');
var http = require('http');
var url = require('url');
var nodemailer = require('nodemailer');
var mail_transporter = nodemailer.createTransport();

var call = require('./call.js');
var digest = require('./digest.js');

var triage_regex = /\btriage:? ?(I-nominated|P-[a-zA-Z0-9\-]+)\b/;
var nom_regex = /\btriage:? ?(I-nominated)\b/;

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
                    res.writeHead(200, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"});
                    res.end("Success?\n\n" + output);
                } catch (e) {
                    res.writeHead(200, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"});
                    res.end("Error: " + e);
                }
            });
        } else if (pathname == '/mail_digest') {
            var output = produce_digest();
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

    // Check the user.
    if (config.triagers.indexOf(body.sender.login) == 0) {
        data.push({
            "action": "bad access",
            "issue_number": body.issue.number,
            "issue_title": body.issue.title,
            "label": "",
            "user": body.sender.login,
            "comment": body.comment.body
        });
        return "No, user " + body.sender.login + " may not triage via comments";
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
        var priority = match[1];

        // Set the priority on the issue and record the changes.
        //   remove any existing priorities.
        issue_labels.map(function(label) {
            if (is_priority(label.name)) {
                // Send request to GH to remove label.
                call.remove_label(issue_number, label.name, config);

                // Don't need to record it, we'll get the GH hooks for it later.
            }
        });

        // Add the new label, record in pending and data.
        pending[issue_number + priority] = true;
        var record = {
            "action": "add",
            "issue_number": issue_number,
            "issue_title": issue_title,
            "label": priority,
            "user": user,
            "comment": comment
        };
        data.push(record);

        call.add_label(issue_number, priority, config);
    }
}

function added_label(issue_number, issue_title, label, user) {
    if (!is_priority(label)) {
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
        "user": user,
        "comment": ""
    };
    data.push(record);
}

function removed_label(issue_number, issue_title, label, user) {
    if (!is_priority(label)) {
        return;
    }

    var record = {
        "action": "remove",
        "issue_number": issue_number,
        "issue_title": issue_title,
        "label": label,
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
    return label.indexOf("P-") == 0 || label == "I-nominated";
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

function produce_digest() {
    var cur_data = data;
    data = [];

    var html = digest.make_digest(cur_data, config);

    // Save the digest to a file.
    var date = new Date();
    var digest_path = path.resolve(__dirname, "digests", date.toISOString().replace(/[:\.]/g, "-") + ".html");
    fs.writeFileSync(digest_path, html);

    // Save the now empty data to file.
    save_data();

    // Send an email
    var addresses_filename = path.resolve(__dirname, email_filename);
    var addresses = JSON.parse(fs.readFileSync(addresses_filename, 'utf8'));
    var email = {
        "from": "nrc@ncameron.org",
        "to": addresses,
        "subject": "Triage digest",
        "html": html
    };
    mail_transporter.sendMail(email, function(err, info) {
        console.log(err);
        console.log(info);
    });

    // Return the html so it can be displayed in the browser.
    return html;
}