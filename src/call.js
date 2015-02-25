// Copyright 2015 authors shown at
// https://github.com/nick29581/rust-triage/graphs/contributors.
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

exports.remove_label = function(issue_number, label, config) {
    exports.api_call('/repos/' + config.owner + '/' + config.repo + '/issues/' + issue_number + '/labels/' + label,
                     function(json) {},
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
