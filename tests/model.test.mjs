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
    data: { viewer: { pullRequests: { nodes: rows.map(([repo, number, sha, rollup]) => ({
      number, title: "PR " + number, url: `https://github.com/${repo}/pull/${number}`, isDraft: false, baseRefName: "main",
      repository: { nameWithOwner: repo },
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
