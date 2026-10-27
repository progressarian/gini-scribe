# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: giniflow/G58-test-restore.spec.js >> G58 restore a mistakenly cancelled test >> 6. over HTTP: the station lists its cancels, a lab user may restore a lab test, not an echo
- Location: e2e/giniflow/G58-test-restore.spec.js:207:3

# Error details

```
AggregateError: apiRequestContext.post: connect ECONNREFUSED ::1:3101
connect ECONNREFUSED 127.0.0.1:3101
Call log:
  - → POST http://localhost:3101/api/auth/login
    - user-agent: Playwright/1.63.0 (x64; ubuntu 22.04) node/20.20
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - content-type: application/json
    - content-length: 31

```