.pragma library

var MIN_POLL_SECONDS = 30
var MAX_POLL_SECONDS = 900
var PULLS_URL = "https://github.com/pulls"
var MAX_PINGS_PER_POLL = 3
var AVATAR_URL = /^https:\/\/avatars\.githubusercontent\.com\/[A-Za-z0-9\/._~?=&%-]+$/
var LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
var PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/

var QUERY = "query{viewer{login avatarUrl(size:64) "
  + "open:pullRequests(first:100,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC})"
  + "{nodes{number title url isDraft baseRefName repository{nameWithOwner}"
  + " commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}"
  + " merged:pullRequests(first:50,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC})"
  + "{nodes{number title url mergedAt baseRefName repository{nameWithOwner}}}"
  + "}}"

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
  var nodes = data && data.data && data.data.viewer && data.data.viewer.open
    ? data.data.viewer.open.nodes : null
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
      base: String(node.baseRefName || ""),
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
      if (!sameCommit || before.ci !== pull.ci) events.push({ kind: pull.ci, pull: pull })
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

function pingsToSend(events, notifyEnabled, notifyStarted) {
  if (!notifyEnabled) return []
  return notifications(events.filter(function(event) {
    return event.kind !== "started" || notifyStarted
  }))
}

var PANEL_ORDER = { failed: 0, running: 1, passed: 2, none: 3 }
function sortForPanel(pulls) {
  return pulls.map(function(pull, index) { return { pull: pull, index: index } })
    .sort(function(a, b) { return (PANEL_ORDER[a.pull.ci] - PANEL_ORDER[b.pull.ci]) || (a.index - b.index) })
    .map(function(entry) { return entry.pull })
}

var CI_MARK = { failed: "", running: "", passed: "", none: "" }
var CI_LABEL = { failed: "Failed", running: "Running", passed: "Passed", none: "No CI" }
var PULL_ICON_OPEN = ""
var PULL_ICON_DRAFT = ""
var PULL_ICON_MERGED = "\uf419"

function pullIcon(pull) {
  return pull.draft ? PULL_ICON_DRAFT : PULL_ICON_OPEN
}

function pullSubtitle(pull) {
  return pull.repo + " #" + pull.number + (pull.base ? "  → " + pull.base : "") + (pull.draft ? "  ·  draft" : "")
}

var PALETTE_KEYS = {
  red: ["red", "color1"],
  green: ["green", "color2"],
  yellow: ["yellow", "color3"],
  purple: ["magenta", "purple", "color5"]
}

function themePalette(colorsToml) {
  var found = {}
  var lines = String(colorsToml || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) found[match[1]] = match[2]
  }
  var palette = {}
  for (var role in PALETTE_KEYS) {
    palette[role] = ""
    var keys = PALETTE_KEYS[role]
    for (var k = 0; k < keys.length && !palette[role]; k++) palette[role] = found[keys[k]] || ""
  }
  return palette
}

function openUrl(pull) {
  return pull && pull.url ? pull.url : PULLS_URL
}

var MERGED_WINDOW_MS = 24 * 60 * 60 * 1000

function parseMerged(text, nowMs) {
  var data
  try {
    data = JSON.parse(text)
  } catch (parseError) {
    return []
  }
  var nodes = data && data.data && data.data.viewer && data.data.viewer.merged
    ? data.data.viewer.merged.nodes : null
  if (!Array.isArray(nodes)) return []
  var merged = []
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (!node || !node.repository) continue
    var mergedMs = Date.parse(String(node.mergedAt || ""))
    if (!isFinite(mergedMs) || nowMs - mergedMs > MERGED_WINDOW_MS) continue
    var repo = String(node.repository.nameWithOwner)
    merged.push({
      key: repo + "#" + node.number,
      repo: repo,
      number: node.number,
      title: String(node.title || ""),
      url: PR_URL.test(String(node.url || "")) ? String(node.url) : "",
      base: String(node.baseRefName || ""),
      mergedMs: mergedMs
    })
  }
  return merged.sort(function(a, b) { return b.mergedMs - a.mergedMs })
}

function dismissedList(value) {
  var items = Array.isArray(value) ? value : (value ? [value] : [])
  var entries = []
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (typeof item === "string" && item !== "") entries.push({ key: item, mergedMs: null })
    else if (item && typeof item.key === "string" && item.key !== "" && isFinite(item.mergedMs)) entries.push({ key: item.key, mergedMs: Number(item.mergedMs) })
  }
  return entries
}

function isDismissed(dismissed, key) {
  for (var i = 0; i < dismissed.length; i++) if (dismissed[i].key === key) return true
  return false
}

function withinWindow(merged, nowMs) {
  return merged.filter(function(pull) { return nowMs - pull.mergedMs <= MERGED_WINDOW_MS })
}

function visibleMerged(merged, dismissedValue, nowMs) {
  var dismissed = dismissedList(dismissedValue)
  return withinWindow(merged, nowMs).filter(function(pull) { return !isDismissed(dismissed, pull.key) })
}

function keepDismissed(dismissedValue, merged, pullsToDismiss, nowMs) {
  var mergedKeys = merged.map(function(pull) { return pull.key })
  var kept = dismissedList(dismissedValue).filter(function(entry) {
    if (entry.mergedMs === null) return mergedKeys.indexOf(entry.key) !== -1
    return nowMs - entry.mergedMs <= MERGED_WINDOW_MS
  })
  for (var i = 0; i < pullsToDismiss.length; i++) {
    var pull = pullsToDismiss[i]
    if (!isDismissed(kept, pull.key)) kept.push({ key: pull.key, mergedMs: pull.mergedMs })
  }
  return kept
}

function timeAgo(thenMs, nowMs) {
  var minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return minutes + " min ago"
  return Math.floor(minutes / 60) + " h ago"
}

function mergedSubtitle(pull, nowMs) {
  return pull.repo + " #" + pull.number + " \u00b7 merged" + (pull.base ? " into " + pull.base : "") + " \u00b7 " + timeAgo(pull.mergedMs, nowMs)
}

function panelRows(openPulls, merged, dismissedValue, nowMs) {
  var rows = sortForPanel(openPulls).map(function(pull) { return { kind: "open", pull: pull } })
  var shown = visibleMerged(merged, dismissedValue, nowMs)
  if (shown.length > 0) rows.push({ kind: "header", pull: null })
  for (var i = 0; i < shown.length; i++) rows.push({ kind: "merged", pull: shown[i] })
  return rows
}

function parseViewer(text) {
  var data
  try {
    data = JSON.parse(text)
  } catch (parseError) {
    return { login: "", avatarUrl: "" }
  }
  var viewer = data && data.data && data.data.viewer ? data.data.viewer : null
  var login = viewer ? String(viewer.login || "") : ""
  var avatarUrl = viewer ? String(viewer.avatarUrl || "") : ""
  return {
    login: LOGIN.test(login) ? login : "",
    avatarUrl: AVATAR_URL.test(avatarUrl) ? avatarUrl : ""
  }
}
