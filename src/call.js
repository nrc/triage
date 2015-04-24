// Copyright 2015 authors shown at
// https://github.com/nrc/rust-triage/graphs/contributors.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

// A pathetic wrapper around http API calls.

var https = require('https');

exports.api_call = function(path, f, body, config, method) {
    method = method || 'GET';

    //console.log(path);
    //console.log(body);

    var opts = {
        host :"api.github.com",
        path : path,
        method : method,
        body: body,
        headers: {'user-agent': config.username, 'Authorization': 'token ' + config.token }
    };

    var request = https.request(opts, function(response) {
        var body = '';
        response.on('data', function(chunk){
            body += chunk;
        });
        response.on('end', function() {
            //console.log("recevied:")
            //console.log(body);

            var json = JSON.parse(body);
            f(json);
        });
    });

    if (body) {
        request.write(JSON.stringify(body));
    }

    request.end();
}

exports.remove_label = function(issue_number, label, config, callback) {
    exports.api_call('/repos/' + config.owner + '/' + config.repo + '/issues/' + issue_number + '/labels/' + label,
                     function(json) {
                        if (callback) {
                            callback(null, json);
                        }
                     },
                     {},
                     config,
                     'DELETE');
}

exports.add_label = function(issue_number, label, config) {
    var body = [label];
    exports.api_call('/repos/' + config.owner + '/' + config.repo + '/issues/' + issue_number + '/labels',
                     function(json) {},
                     body,
                     config,
                     'POST');
}

exports.issues_for_label = function(label, config, state, callback) {
    // FIXME: It's possible there are more issues than whatever GH uses for a limit,
    // in that case we need to follow the next URL to get the next set of issues
    // until we're got them all. We shouldn't even have enough nominated issues
    // for this to be a problem though.
    exports.api_call('/repos/' + config.owner + '/' + config.repo + '/issues?labels=' + label + '&state=' + state,
                     function(json) {
                        if (callback) {
                            // The GH API lets you do this using direction=asc, but it
                            // just plain doesn't work for me :-s
                            json.reverse();
                            callback(null, json);
                        }
                     },
                     {},
                     config,
                     'GET');    
}

exports.set_milestone = function(issue_number, milestone, config) {
    if (milestone == "") {
        var body = {
            "milestone": 0
        };
        exports.api_call('/repos/' + config.owner + '/' + config.repo + '/issues/' + issue_number,
                         function(json) {},
                         body,
                         config,
                         'PATCH');

        return;
    }
    // First get the number for this milestone, then set it for the issue.
    exports.api_call('/repos/' + config.owner + '/' + config.repo + '/milestones',
                     function(json) {
                        var number = search_for_milestone(json, milestone);
                        if (number >= 0) {
                            var body = {
                                "milestone": number
                            };
                            exports.api_call('/repos/' + config.owner + '/' + config.repo + '/issues/' + issue_number,
                                             function(json) {},
                                             body,
                                             config,
                                             'PATCH');
                        }
                     },
                     {},
                     config,
                     'GET');
}

function search_for_milestone(data, milestone) {
    for (var i in data) {
        var ms_data = data[i];
        if (ms_data.title == milestone) {
            return ms_data.number;
        }
    }

    return -1;    
}
