# Archive viewer

The reading page of a private research archive. It holds none of the archive: a visitor signs in
with their own GitHub access token, and the page fetches the notes from the private repository
straight into their browser. Without a token that can read that repository, it shows nothing.

This repository is built from `tools/app` of the archive by `./archive viewer --push`. Do not edit
it by hand: whatever is changed here is overwritten the next time it is published.
