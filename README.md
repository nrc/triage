Scripts for triaging and prioritising Rust issues

Everything interesting is in `src`. You'll need to copy `config.json.orig` to
`config.json` and fill out all the values. Run using `run.sh` in `src` (you'll
need to setup by running `init.sh` in `staging` first). To run on a server,
first use `run.sh`, then copy everything in `staging` to the server, run
`init.sh`, then `nohup nodejs triage.js &`. I think node.js is the only
prerequisite.

You'll need to setup your GitHub repo to send a webhook on issue comments and
issues (which covers new issues and [de-]labeling).


### API

`/hook` receive GitHub web hook. We record priority changes made by changing
labels (any label starting with `P-` or `I-nominated`). We also allow changing
labels in a comment using, for example, `triage: P-high`. The comment is then
also recorded. Users allowed to do this are listed in `config.json`

`/data` dump currently collected data as JSON.

`/mail_digest` trigger the digest email and empty the current data state.


### Source overview

Most of the work is done in `triage.js`. `call.js` has some basic helper
functions for making GitHub API calls. `digest.js` produces the digest email
text (as html).

The current state of the program is pretty much all in the `data` global. This
is regularly stored to disk (in `data.json`) so we can recover from a crash.

We record all priority changes, either by label changes or by using `triage` in
a comment (the latter is preferred since the comment can add context). Sending
an email sends all recorded changes to the email address listed in
`emails.json`. It also saves a copy in the `digests` folder. It then resets the
current state.
