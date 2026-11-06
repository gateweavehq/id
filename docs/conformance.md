# The OpenID conformance suite

`pnpm test:conformance` runs the [OpenID Foundation's conformance suite](https://gitlab.com/openid/conformance-suite)
against a local build of ID, plays the person in a browser, and compares what the suite says of every test
with [`apps/web/conformance/expected.ts`](../apps/web/conformance/expected.ts). Any difference fails the run,
a better result included, so that file and this page stay true.

ID is not certified. Certification is a separate step with the Foundation, which may carry a fee and has not
been decided on. What can be said is that the suite's plans pass, as this page describes.

## What the suite says

| Plan      | Apps                 | Result                                                                        |
| --------- | -------------------- | ----------------------------------------------------------------------------- |
| Config OP |                      | Passed                                                                        |
| Basic OP  | First-party          | 23 passed, 4 warnings, 4 skipped, 4 left for a person to look at, none failed |
| Basic OP  | Added by a workspace | The same, except that one test fails on purpose                               |

This is version `release-v5.3.4` of the suite. The tests that do not plainly pass, and why:

**Warnings, which stay.**

- `oidcc-scope-profile`: ID holds a name and a picture, not every standard profile claim.
- `oidcc-scope-email` and `oidcc-alternate-happy-flow`: the ID token holds the address as well as userinfo,
  because Cloudflare Access reads nothing but the ID token.
- `oidcc-claims-essential`: the `claims` parameter is dropped from every request, and discovery says so.

**Skipped, which the suite allows.**

- `oidcc-scope-address`, `oidcc-scope-phone` and `oidcc-scope-all`: ID holds no address and no phone number.
- `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported`: request objects are refused
  with `request_not_supported`, as discovery says.

**Left for a person to look at.** The suite cannot see these pages, and asks for a picture of them. A run
checks that ID really showed the page, and uploads the picture.

- `oidcc-prompt-login` and `oidcc-max-age-1`: the sign-in page, a second time.
- `oidcc-ensure-registered-redirect-uri` and `oidcc-ensure-request-object-with-redirect-uri`: the page that
  says the request was refused, with no redirect to the address the request named.

**The test that fails on purpose, for apps a workspace adds.** `oidcc-prompt-none-not-logged-in` expects
`login_required` to be sent back to the app. An app a workspace adds gets the sign-in page instead. Anyone can
add an app, so a quiet redirect to it would make ID an open redirector ([RFC 9700, section 4.11.2](https://www.rfc-editor.org/rfc/rfc9700#section-4.11.2)).
First-party apps, which only a deployment can register, get what the test expects.

### What the apps in a run are set to

These plans do not use PKCE, which ID asks of every app unless it says otherwise. So the apps in a run say
they need not, as many real libraries have to, and one of each three sends its secret in the body of the
request, which the suite has a test for. Both are settings an app can have, described in
[Connect an app](connect-an-app.md#if-your-library-needs-something-else). So a run says nothing about an app
that keeps the defaults. The Worker tests and browser tests cover those.

## Run it

It needs Docker, and the browser the browser tests use
(`pnpm --filter @gateweave/id-web exec playwright install chromium`). The ports are 8443 and 8444 for the
suite, 4734 for ID over https, and 4732 and 4733 as for the browser tests, so run neither at the same time.

```sh
pnpm test:conformance
```

The first run pulls about two gigabytes of images. After that it takes a few minutes. It prints what differs,
and saves what it saw, with pictures, in `apps/web/conformance/results`, which git ignores.

From `apps/web`, `node conformance/run.mjs workspace` runs only one kind of app. `CONFORMANCE_TESTS=a,b` runs
only those tests, `CONFORMANCE_KEEP=1` leaves the suite up for next time, and `CONFORMANCE_NO_BUILD=1` uses a
build this script has already made.

## In CI

[`conformance.yml`](../.github/workflows/conformance.yml) runs it on pull requests and pushes to `main` that
touch the code that signs people in, the routes, the lockfile or the suite's own files, and once a week for
anything else. An upgrade of Better Auth is what it is most likely to catch, which is why the lockfile is on
that list. It is not a required check and it has no part in deploying.

## When it fails

Read which test differs and what the suite said. A new failure gets fixed, in ID or, if it is Better Auth's,
upstream too. Change `expected.ts` only when the new result is right, say why in the same line, and change
this page with it. A test that starts to pass is good news, and takes the same change.

## How it reaches ID

The suite fails an issuer on plain http, and the provider turns any issuer that is not on this machine to
https. So a run's build has the address `https://id.localhost:4734` (`ID_E2E_URL` in `vite.config.ts`), and
the `id` service in [`docker-compose.yml`](../apps/web/conformance/docker-compose.yml) puts https in front of
the usual preview on port 4732. It uses the certificate in the suite's own nginx image. The suite's containers
find `id.localhost` as that service, and a browser takes anything under `.localhost` for this machine, so both
use the same address, as the issuer requires.

The preview listens on every address for the length of a run, because a container reaches this machine by
something other than `localhost`. It holds nothing but the run's seeded person and apps.

The same plans can run against a deployed ID, with a person and apps made there. Nothing in this repository
does that, because Turnstile can stop a script at the sign-in page. It was done by hand on staging, as
[What has been proven](architecture.md#what-has-been-proven) says.

To change the suite's version, change the two image tags, and read what the new tests say.
