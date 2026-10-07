.pragma library

var MIN_POLL_SECONDS = 30
var MAX_POLL_SECONDS = 900
var PULLS_URL = "https://github.com/pulls"
var MAX_PINGS_PER_POLL = 3
var PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/

var QUERY = "query{viewer{pullRequests(first:100,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC})"
  + "{nodes{number title url isDraft repository{nameWithOwner}"
  + " commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}}}"

function clampPollSeconds(value) {
  var seconds = Math.round(Number(value))
  if (!isFinite(seconds)) return 60
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, seconds))
}

function ciState(rollup) {
  switch (rollup) {
  case "PENDING":
  case "EXPECTED":
    return "running"
  case "SUCCESS":
    return "passed"
  case "FAILURE":
  case "ERROR":
    return "failed"
  default:
    return "none"
  }
}

function parsePulls(text) {
  var data = JSON.parse(text)
  var nodes = data && data.data && data.data.viewer && data.data.viewer.pullRequests
    ? data.data.viewer.pullRequests.nodes : null
  if (!Array.isArray(nodes)) throw new Error("unexpected answer from GitHub")
  var pulls = []
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (!node || !node.repository) continue
    var commitNodes = node.commits && node.commits.nodes ? node.commits.nodes : []
    var commit = commitNodes.length > 0 && commitNodes[0] ? commitNodes[0].commit : null
    var repo = String(node.repository.nameWithOwner)
    pulls.push({
      key: repo + "#" + node.number,
      repo: repo,
      number: node.number,
      title: String(node.title || ""),
      url: PR_URL.test(String(node.url || "")) ? String(node.url) : "",
      draft: node.isDraft === true,
      sha: commit ? String(commit.oid || "") : "",
      ci: ciState(commit && commit.statusCheckRollup ? commit.statusCheckRollup.state : null)
    })
  }
  return pulls
}

function snapshot(pulls, previous) {
  var seen = {}
  for (var key in previous || {}) if (previous.hasOwnProperty(key)) seen[key] = previous[key]
  for (var i = 0; i < pulls.length; i++) seen[pulls[i].key] = { sha: pulls[i].sha, ci: pulls[i].ci }
  return seen
}

function changes(previous, pulls) {
  if (!previous) return []
  var events = []
  for (var i = 0; i < pulls.length; i++) {
    var pull = pulls[i]
    var before = previous.hasOwnProperty(pull.key) ? previous[pull.key] : null
    var sameCommit = before !== null && before.sha === pull.sha
    if (pull.ci === "running") {
      if (!sameCommit || before.ci !== "running") events.push({ kind: "started", pull: pull })
    } else if (pull.ci === "passed" || pull.ci === "failed") {
      if (before !== null && (!sameCommit || before.ci !== pull.ci)) events.push({ kind: pull.ci, pull: pull })
    }
  }
  return events
}

function countByState(pulls) {
  var counts = { running: 0, passed: 0, failed: 0, none: 0 }
  for (var i = 0; i < pulls.length; i++) counts[pulls[i].ci]++
  return counts
}

function escapeMarkup(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function notification(event) {
  var pull = event.pull
  var body = escapeMarkup(pull.repo) + " #" + pull.number + "\n" + escapeMarkup(pull.title)
  if (event.kind === "started") return { urgency: "low", timeoutMs: 6000, title: "⏳ CI running", body: body }
  if (event.kind === "passed") return { urgency: "normal", timeoutMs: 8000, title: "✅ CI passed", body: body }
  return { urgency: "critical", timeoutMs: 0, title: "❌ CI failed", body: body }
}

function notifications(events) {
  if (events.length <= MAX_PINGS_PER_POLL) return events.map(notification)
  var counts = { started: 0, passed: 0, failed: 0 }
  for (var i = 0; i < events.length; i++) counts[events[i].kind]++
  var parts = []
  if (counts.failed) parts.push(counts.failed + " failed")
  if (counts.passed) parts.push(counts.passed + " passed")
  if (counts.started) parts.push(counts.started + " running")
  var failed = counts.failed > 0
  return [{
    urgency: failed ? "critical" : "normal",
    timeoutMs: failed ? 0 : 8000,
    title: (failed ? "❌" : "✅") + " CI on " + events.length + " pull requests",
    body: parts.join(" · ")
  }]
}

var PANEL_ORDER = { failed: 0, running: 1, passed: 2, none: 3 }
function sortForPanel(pulls) {
  return pulls.map(function(pull, index) { return { pull: pull, index: index } })
    .sort(function(a, b) { return (PANEL_ORDER[a.pull.ci] - PANEL_ORDER[b.pull.ci]) || (a.index - b.index) })
    .map(function(entry) { return entry.pull })
}

var STATE_ICON = { failed: "", running: "󰔟", passed: "", none: "" }
var STATE_TEXT = { failed: "CI failed", running: "CI running", passed: "CI passed", none: "No CI" }

function openUrl(pull) {
  return pull && pull.url ? pull.url : PULLS_URL
}
