import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import vm from "node:vm"
import assert from "node:assert/strict"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "..", "Model.js"), "utf8").replace(/^\.pragma library\s*/, "")
const M = {}
vm.createContext(M)
vm.runInContext(source, M)

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log("ok   " + name)
  } catch (e) {
    failures++
    console.log("FAIL " + name + "\n     " + e.message)
  }
}

function answer(rows) {
  return JSON.stringify({
    data: { viewer: { open: { nodes: rows.map(([repo, number, sha, rollup]) => ({
      number, title: "PR " + number, url: `https://github.com/${repo}/pull/${number}`, isDraft: false, baseRefName: "main",
      repository: { nameWithOwner: repo, isPrivate: repo.startsWith("private/") },
      commits: { nodes: sha ? [{ commit: { oid: sha, statusCheckRollup: rollup ? { state: rollup } : null } }] : [] }
    })) } } }
  })
}
const kinds = (events) => [...events].map((e) => e.kind + " " + e.pull.key)
function step(previous, rows) {
  const pulls = M.parsePulls(answer(rows))
  return { events: kinds(M.changes(previous, pulls)), next: M.snapshot(pulls, previous), pulls }
}

test("rollup states fold into running, passed, failed, none", () => {
  assert.equal(M.ciState("PENDING"), "running")
  assert.equal(M.ciState("EXPECTED"), "running")
  assert.equal(M.ciState("SUCCESS"), "passed")
  assert.equal(M.ciState("FAILURE"), "failed")
  assert.equal(M.ciState("ERROR"), "failed")
  assert.equal(M.ciState(null), "none")
})

test("parsePulls reads repo, number, sha and CI state", () => {
  const [p] = M.parsePulls(answer([["me/app", 7, "abc", "PENDING"]]))
  assert.equal(p.key, "me/app#7")
  assert.equal(p.sha, "abc")
  assert.equal(p.ci, "running")
})

test("parsePulls handles a PR with no commits and no checks", () => {
  const pulls = M.parsePulls(answer([["me/app", 1, "", null], ["me/app", 2, "def", null]]))
  assert.deepEqual([...pulls].map((p) => [p.sha, p.ci]), [["", "none"], ["def", "none"]])
})

test("parsePulls throws on an error answer, so the last list is kept", () => {
  assert.throws(() => M.parsePulls(JSON.stringify({ errors: [{ message: "Bad credentials" }] })))
  assert.throws(() => M.parsePulls("not json"))
})

test("first look only sets the baseline", () => {
  const { events } = step(null, [["me/app", 1, "a", "FAILURE"], ["me/app", 2, "b", "PENDING"]])
  assert.deepEqual(events, [])
})

test("running then passed: one started, one passed, no repeats", () => {
  let s = step(null, [["me/app", 1, "a", null]])
  s = step(s.next, [["me/app", 1, "b", "PENDING"]])
  assert.deepEqual(s.events, ["started me/app#1"])
  s = step(s.next, [["me/app", 1, "b", "PENDING"]])
  assert.deepEqual(s.events, [])
  s = step(s.next, [["me/app", 1, "b", "SUCCESS"]])
  assert.deepEqual(s.events, ["passed me/app#1"])
  s = step(s.next, [["me/app", 1, "b", "SUCCESS"]])
  assert.deepEqual(s.events, [])
})

test("a failure is reported once", () => {
  let s = step(null, [["me/app", 1, "a", "PENDING"]])
  s = step(s.next, [["me/app", 1, "a", "FAILURE"]])
  assert.deepEqual(s.events, ["failed me/app#1"])
  s = step(s.next, [["me/app", 1, "a", "FAILURE"]])
  assert.deepEqual(s.events, [])
})

test("a re-run on the same commit starts again", () => {
  let s = step(null, [["me/app", 1, "a", "FAILURE"]])
  s = step(s.next, [["me/app", 1, "a", "PENDING"]])
  assert.deepEqual(s.events, ["started me/app#1"])
  s = step(s.next, [["me/app", 1, "a", "SUCCESS"]])
  assert.deepEqual(s.events, ["passed me/app#1"])
})

test("a new commit whose CI finished between polls still reports the result", () => {
  let s = step(null, [["me/app", 1, "a", "SUCCESS"]])
  s = step(s.next, [["me/app", 1, "b", "FAILURE"]])
  assert.deepEqual(s.events, ["failed me/app#1"])
})

test("a push while CI runs starts again for the new commit", () => {
  let s = step(null, [["me/app", 1, "a", "PENDING"]])
  s = step(s.next, [["me/app", 1, "b", "PENDING"]])
  assert.deepEqual(s.events, ["started me/app#1"])
})

test("a PR opened after start is announced, running or already finished", () => {
  let s = step(null, [])
  s = step(s.next, [["me/app", 3, "c", "PENDING"], ["me/lib", 9, "d", "SUCCESS"], ["me/cli", 4, "e", "FAILURE"]])
  assert.deepEqual(s.events, ["started me/app#3", "passed me/lib#9", "failed me/cli#4"])
})

test("CI faster than one poll on a new PR still pings its result once", () => {
  let s = step(null, [["work/api", 4, "a", null]])
  s = step(s.next, [["work/api", 4, "a", null], ["me/plugin", 1, "f", "SUCCESS"]])
  assert.deepEqual(s.events, ["passed me/plugin#1"])
  s = step(s.next, [["work/api", 4, "a", null], ["me/plugin", 1, "f", "SUCCESS"]])
  assert.deepEqual(s.events, [])
})

test("a PR without CI never notifies", () => {
  let s = step(null, [["work/api", 4, "a", null]])
  s = step(s.next, [["work/api", 4, "b", null]])
  assert.deepEqual(s.events, [])
})

test("a PR that drops out of the list for a poll is not announced again", () => {
  let s = step(null, [["me/app", 7, "a", "PENDING"]])
  s = step(s.next, [])
  s = step(s.next, [["me/app", 7, "a", "PENDING"]])
  assert.deepEqual(s.events, [])
  s = step(s.next, [])
  s = step(s.next, [["me/app", 7, "a", "SUCCESS"]])
  assert.deepEqual(s.events, ["passed me/app#7"])
})

test("panel lists failures first, then running, passed, no CI", () => {
  const pulls = step(null, [["o/r", 1, "a", null], ["o/r", 2, "b", "SUCCESS"], ["o/r", 3, "c", "FAILURE"],
    ["o/r", 4, "d", "PENDING"], ["o/r", 5, "e", "ERROR"]]).pulls
  assert.equal([...M.sortForPanel(pulls)].map((p) => p.number).join(" "), "3 5 4 2 1")
})

test("a row opens exactly its PR", () => {
  const [pull] = step(null, [["o/r", 7, "a", "FAILURE"]]).pulls
  assert.equal(M.openUrl(pull), "https://github.com/o/r/pull/7")
  assert.equal(M.openUrl({ url: "" }), "https://github.com/pulls")
})

test("failures stay on screen, the rest time out", () => {
  const pull = step(null, [["me/app", 1, "a", "FAILURE"]]).pulls[0]
  assert.equal(M.notification({ kind: "failed", pull }).urgency, "critical")
  assert.equal(M.notification({ kind: "failed", pull }).timeoutMs, 0)
  assert.ok(M.notification({ kind: "passed", pull }).timeoutMs > 0)
  assert.ok(M.notification({ kind: "started", pull }).timeoutMs > 0)
})

test("a PR title cannot inject markup into the ping", () => {
  const pull = step(null, [["me/app", 1, "a", "FAILURE"]]).pulls[0]
  pull.title = '<a href="https://evil.example">Re-auth</a> & Vec<T>'
  const body = M.notification({ kind: "failed", pull }).body
  assert.ok(!body.includes("<"), body)
  assert.ok(body.includes("&lt;a href=\"https://evil.example\"&gt;Re-auth&lt;/a&gt; &amp; Vec&lt;T&gt;"), body)
})

test("only a plain GitHub PR address can reach xdg-open", () => {
  const bad = ["file:///etc/passwd", "--help", "javascript:alert(1)", "https://evil.example/o/r/pull/1",
    "https://github.com/o/r/pull/1 --x", "https://github.com/o/r/pull/1/../../x", ""]
  for (const url of bad) {
    const text = answer([["o/r", 1, "a", "FAILURE"]]).replace("https://github.com/o/r/pull/1", url.replace(/"/g, '\\"'))
    const pulls = M.parsePulls(text)
    assert.equal(pulls[0].url, "", url)
    assert.equal(M.openUrl(pulls[0]), "https://github.com/pulls", url)
  }
  assert.equal(M.parsePulls(answer([["o/r", 1, "a", "FAILURE"]]))[0].url, "https://github.com/o/r/pull/1")
})

test("many changes in one poll become a single summary ping", () => {
  let s = step(null, [1, 2, 3, 4, 5].map((n) => ["me/app", n, "a", "PENDING"]))
  const pulls = M.parsePulls(answer([1, 2, 3, 4, 5].map((n) => ["me/app", n, "a", n < 3 ? "FAILURE" : "SUCCESS"])))
  const pings = M.notifications(M.changes(s.next, pulls))
  assert.equal(pings.length, 1)
  assert.equal(pings[0].urgency, "critical")
  assert.equal(pings[0].body, "2 failed · 3 passed")
  const few = M.notifications(M.changes(s.next, pulls.slice(0, 3)))
  assert.equal(few.length, 3)
})

test("a row shows the repo, number and the branch the PR goes into", () => {
  const [pull] = step(null, [["o/r", 2, "a", "SUCCESS"]]).pulls
  assert.equal(pull.base, "main")
  assert.equal(M.pullSubtitle(pull), "o/r #2  → main")
  assert.equal(M.pullSubtitle({ ...pull, draft: true }), "o/r #2  → main  ·  draft")
  assert.equal(M.pullIcon({ draft: false }), M.PULL_ICON_OPEN)
  assert.equal(M.pullIcon({ draft: true }), M.PULL_ICON_DRAFT)
})

test("every CI state has a mark and a label", () => {
  for (const ci of ["failed", "running", "passed", "none"]) {
    assert.equal(typeof M.CI_MARK[ci], "string", ci)
    assert.ok(M.CI_LABEL[ci], ci)
  }
  assert.equal(M.CI_MARK.none, "")
})

test("theme palette reads named colors, falls back to colorN, else stays empty", () => {
  assert.deepEqual({ ...M.themePalette('red = "#f7768e"\ngreen = "#9ece6a"\nyellow = "#e0af68"\nmagenta = "#ad8ee6"') },
    { red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", purple: "#ad8ee6" })
  assert.deepEqual({ ...M.themePalette("color1 = '#aa0000'\ncolor2 = '#00aa00'\ncolor3 = '#aaaa00'\ncolor5 = '#aa00aa'") },
    { red: "#aa0000", green: "#00aa00", yellow: "#aaaa00", purple: "#aa00aa" })
  assert.deepEqual({ ...M.themePalette("") }, { red: "", green: "", yellow: "", purple: "" })
})

test("pings off sends nothing; started pings can be turned off alone", () => {
  let s = step(null, [["o/r", 1, "a", null], ["o/r", 2, "b", "PENDING"]])
  const pulls = M.parsePulls(answer([["o/r", 1, "a", "PENDING"], ["o/r", 2, "b", "FAILURE"]]))
  const events = M.changes(s.next, pulls)
  assert.equal(M.pingsToSend(events, false, true).length, 0)
  assert.deepEqual([...M.pingsToSend(events, true, false)].map((p) => p.title), ["\u274c CI failed"])
  assert.equal(M.pingsToSend(events, true, true).length, 2)
})

const NOW = Date.parse("2026-10-07T20:00:00Z")
const HOUR = 60 * 60 * 1000
function mergedAnswer(rows) {
  return JSON.stringify({ data: { viewer: { open: { nodes: [] }, merged: { nodes: rows.map(([repo, number, hoursAgo, base]) => ({
    number, title: "Merged " + number, url: `https://github.com/${repo}/pull/${number}`,
    mergedAt: new Date(NOW - hoursAgo * HOUR).toISOString(), baseRefName: base, repository: { nameWithOwner: repo }
  })) } } } })
}

test("merged PRs show for 24 hours, newest first, with the branch they went into", () => {
  const merged = M.parseMerged(mergedAnswer([["o/r", 1, 25, "main"], ["o/r", 2, 3, "main"], ["o/r", 3, 0.5, "develop"]]), NOW)
  assert.deepEqual([...merged].map((p) => p.number), [3, 2])
  assert.equal(M.mergedSubtitle(merged[0], NOW), "o/r #3 \u00b7 merged into develop \u00b7 30 min ago")
  assert.equal(M.mergedSubtitle(merged[1], NOW), "o/r #2 \u00b7 merged into main \u00b7 3 h ago")
})

test("a bad merged answer never breaks the open list", () => {
  assert.deepEqual([...M.parseMerged("not json", NOW)], [])
  assert.deepEqual([...M.parseMerged(JSON.stringify({ data: { viewer: { open: { nodes: [] } } } }), NOW)], [])
  const text = mergedAnswer([["o/r", 1, 1, "main"]]).replace("https://github.com/o/r/pull/1", "file:///etc/passwd")
  assert.equal(M.parseMerged(text, NOW)[0].url, "")
})

test("a dismissed merged PR leaves the panel and stays hidden until its day is over", () => {
  const merged = M.parseMerged(mergedAnswer([["o/r", 1, 1, "main"], ["o/r", 2, 2, "main"]]), NOW)
  let dismissed = M.keepDismissed([], merged, [merged[0]], NOW)
  assert.deepEqual([...M.visibleMerged(merged, dismissed, NOW)].map((p) => p.key), ["o/r#2"])
  const onlyTwo = merged.filter((p) => p.key === "o/r#2")
  dismissed = M.keepDismissed(dismissed, onlyTwo, [onlyTwo[0]], NOW)
  assert.deepEqual([...dismissed].map((d) => d.key), ["o/r#1", "o/r#2"])
  assert.deepEqual([...M.visibleMerged(merged, dismissed, NOW)], [])
  assert.deepEqual([...M.keepDismissed(dismissed, [], [], NOW + 24 * HOUR)].map((d) => d.key), [])
})

test("dismissed keys saved as one string or with junk still work", () => {
  const merged = M.parseMerged(mergedAnswer([["o/r", 1, 1, "main"], ["o/r", 2, 2, "main"]]), NOW)
  assert.deepEqual([...M.visibleMerged(merged, "o/r#1", NOW)].map((p) => p.key), ["o/r#2"])
  assert.deepEqual([...M.visibleMerged(merged, ["o/r#2", 7, null, "", { key: "o/r#1" }], NOW)].map((p) => p.key), ["o/r#1"])
  assert.deepEqual([...M.visibleMerged(merged, "", NOW)].map((p) => p.key), ["o/r#1", "o/r#2"])
  assert.deepEqual([...M.keepDismissed(["o/r#1", "gone/repo#9"], merged, [], NOW)].map((d) => d.key), ["o/r#1"])
})

test("a merged PR leaves the panel after 24 hours even when GitHub stops answering", () => {
  const merged = M.parseMerged(mergedAnswer([["o/r", 1, 23, "main"]]), NOW)
  assert.equal(M.visibleMerged(merged, [], NOW).length, 1)
  assert.equal(M.visibleMerged(merged, [], NOW + 2 * HOUR).length, 0)
  assert.deepEqual([...M.panelRows([], merged, [], NOW + 2 * HOUR)], [])
})

test("hidden merged PRs stay hidden when settings come back as a list-like object", () => {
  const merged = M.parseMerged(mergedAnswer([["o/r", 1, 1, "main"], ["o/r", 2, 2, "main"]]), NOW)
  const listLike = { 0: { key: "o/r#1", mergedMs: merged[0].mergedMs }, length: 1 }
  assert.deepEqual([...M.visibleMerged(merged, listLike, NOW)].map((p) => p.key), ["o/r#2"])
  assert.deepEqual([...M.keepDismissed(listLike, merged, [], NOW)].map((d) => d.key), ["o/r#1"])
})

test("panel rows: open first, then a header and the merged ones still shown", () => {
  const open = step(null, [["o/r", 5, "a", "SUCCESS"], ["o/r", 6, "b", "FAILURE"]]).pulls
  const merged = M.parseMerged(mergedAnswer([["o/r", 1, 1, "main"], ["o/r", 2, 2, "main"]]), NOW)
  assert.deepEqual([...M.panelRows(open, merged, ["o/r#2"], NOW)].map((r) => r.kind + (r.pull ? r.pull.number : "")),
    ["open6", "open5", "header", "merged1"])
  assert.deepEqual([...M.panelRows(open, merged, ["o/r#1", "o/r#2"], NOW)].map((r) => r.kind), ["open", "open"])
})

test("time ago reads in minutes, then hours", () => {
  assert.equal(M.timeAgo(NOW - 20 * 1000, NOW), "just now")
  assert.equal(M.timeAgo(NOW - 5 * 60 * 1000, NOW), "5 min ago")
  assert.equal(M.timeAgo(NOW - 23.9 * HOUR, NOW), "23 h ago")
})

test("the avatar is a GitHub avatar address, or nothing", () => {
  const viewer = (avatarUrl) => JSON.stringify({ data: { viewer: { avatarUrl, open: { nodes: [] } } } })
  assert.equal(M.parseViewer(viewer("https://avatars.githubusercontent.com/u/1?s=64&v=4")).avatarUrl,
    "https://avatars.githubusercontent.com/u/1?s=64&v=4")
  for (const bad of ["http://avatars.githubusercontent.com/u/1", "https://evil.example/u/1.png", "file:///etc/passwd",
    "https://avatars.githubusercontent.com.evil.example/u/1", "https://avatars.githubusercontent.com/u/1 x", ""]) {
    assert.equal(M.parseViewer(viewer(bad)).avatarUrl, "", bad)
  }
  assert.deepEqual({ ...M.parseViewer("not json") }, { avatarUrl: "" })
})

test("the star link points at the plugin's own GitHub repository, or is hidden", () => {
  assert.equal(M.repositoryUrl({ repository: "https://github.com/pedroolivy/omarchy-ci-ping" }), "https://github.com/pedroolivy/omarchy-ci-ping")
  assert.equal(M.repositoryUrl({ repository: "https://github.com/someone/fork.git" }), "https://github.com/someone/fork")
  assert.equal(M.repositoryUrl({ homepage: "https://github.com/a/b/" }), "https://github.com/a/b")
  for (const bad of ["https://evil.example/a/b", "file:///etc", "https://github.com/a", "https://github.com/a/b/c", ""]) {
    assert.equal(M.repositoryUrl({ repository: bad }), "", bad)
  }
  assert.equal(M.repositoryUrl(null), "")
})

test("the query asks about the project only for a plain GitHub repository", () => {
  assert.ok(M.buildQuery("https://github.com/pedroolivy/omarchy-ci-ping").endsWith(' project:repository(owner:"pedroolivy",name:"omarchy-ci-ping"){viewerHasStarred}}'))
  assert.ok(!M.buildQuery("").includes("project:"))
  assert.ok(!M.buildQuery('https://github.com/a/b"){x}').includes("project:"))
})

test("star state is true, false, or unknown", () => {
  const answer = (project) => JSON.stringify({ data: { viewer: { open: { nodes: [] } }, project } })
  assert.equal(M.parseStarred(answer({ viewerHasStarred: true })), true)
  assert.equal(M.parseStarred(answer({ viewerHasStarred: false })), false)
  assert.equal(M.parseStarred(answer(null)), null)
  assert.equal(M.parseStarred(answer(undefined)), null)
  assert.equal(M.parseStarred("not json"), null)
})

test("a partial answer with a missing CI state never makes a result ping twice", () => {
  const good = (rollup) => M.parsePulls(answer([["o/r", 1, "abc", rollup]]))
  let previous = M.snapshot(good("PENDING"), null, false)
  assert.deepEqual(kinds(M.changes(previous, good("SUCCESS"))), ["passed o/r#1"])
  previous = M.snapshot(good("SUCCESS"), previous, false)
  const partial = M.parsePulls(answer([["o/r", 1, "abc", null]]))
  assert.deepEqual(kinds(M.changes(previous, partial)), [])
  previous = M.snapshot(partial, previous, true)
  assert.deepEqual(kinds(M.changes(previous, good("SUCCESS"))), [])
  const noCommit = M.parsePulls(answer([["o/r", 1, "", null]]))
  previous = M.snapshot(noCommit, previous, true)
  assert.deepEqual(kinds(M.changes(previous, good("SUCCESS"))), [])
})

test("the summary icon says what happened", () => {
  const pulls = M.parsePulls(answer([1, 2, 3, 4].map((n) => ["o/r", n, "a", null])))
  const events = (kind) => pulls.map((pull) => ({ kind, pull }))
  assert.equal(M.notifications(events("started"))[0].title, "⏳ CI on 4 pull requests")
  assert.equal(M.notifications(events("passed"))[0].title, "✅ CI on 4 pull requests")
  assert.equal(M.notifications([...events("passed").slice(0, 3), { kind: "failed", pull: pulls[3] }])[0].title, "❌ CI on 4 pull requests")
})

test("after failed polls the plugin waits longer, up to 15 minutes", () => {
  assert.equal(M.nextPollSeconds(60, 0), 60)
  assert.equal(M.nextPollSeconds(60, 1), 120)
  assert.equal(M.nextPollSeconds(60, 3), 480)
  assert.equal(M.nextPollSeconds(60, 9), 900)
  assert.equal(M.nextPollSeconds(30, 2), 120)
  assert.equal(M.nextPollSeconds(60, -4), 60)
})

test("a ping never names a private repository or its pull request", () => {
  let s = step(null, [["private/secret-app", 9, "a", "PENDING"], ["o/public", 3, "b", "PENDING"]])
  const pulls = M.parsePulls(answer([["private/secret-app", 9, "a", "FAILURE"], ["o/public", 3, "b", "SUCCESS"]]))
  const [privatePing, publicPing] = M.notifications(M.changes(s.next, pulls))
  assert.equal(privatePing.title, "❌ CI failed")
  assert.ok(!privatePing.body.includes("secret-app") && !privatePing.body.includes("PR 9"), privatePing.body)
  assert.equal(privatePing.body, M.PRIVATE_PING_BODY)
  assert.equal(publicPing.body, "o/public #3\nPR 3")
})

test("a repository with unknown visibility is treated as private", () => {
  const text = JSON.stringify({ data: { viewer: { open: { nodes: [{ number: 1, title: "t", url: "https://github.com/o/r/pull/1",
    isDraft: false, baseRefName: "main", repository: { nameWithOwner: "o/r" }, commits: { nodes: [] } }] } } } })
  assert.equal(M.parsePulls(text)[0].private, true)
})

test("a pull request link opens through a redirect page, never as a process argument", () => {
  assert.equal(M.isPullUrl("https://github.com/private/secret-app/pull/9"), true)
  assert.equal(M.isPullUrl("https://github.com/pulls"), false)
  assert.equal(M.isPullUrl("https://github.com/pedroolivy/omarchy-ci-ping"), false)
  const page = M.redirectPage("https://github.com/private/secret-app/pull/9")
  assert.ok(page.includes('content="0;url=https://github.com/private/secret-app/pull/9"'), page)
  assert.ok(page.includes('name="referrer" content="no-referrer"'))
  assert.ok(M.redirectPage('https://evil.example/"><script>').includes("url=https://github.com/pulls"))
})

test("poll interval is clamped to 30..900 seconds", () => {
  assert.equal(M.clampPollSeconds(5), 30)
  assert.equal(M.clampPollSeconds(60), 60)
  assert.equal(M.clampPollSeconds(5000), 900)
  assert.equal(M.clampPollSeconds("abc"), 60)
})

if (failures) {
  console.log(`\n${failures} failing`)
  process.exit(1)
}
console.log("\nall passing")
