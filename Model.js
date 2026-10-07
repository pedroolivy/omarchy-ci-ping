.pragma library

var MIN_POLL_SECONDS = 30
var MAX_POLL_SECONDS = 900
var PULLS_URL = "https://github.com/pulls"
var MAX_PINGS_PER_POLL = 3
var AVATAR_URL = /^https:\/\/avatars\.githubusercontent\.com\/[A-Za-z0-9\/._~?=&%-]+$/
var REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
var PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/

var VIEWER_FIELDS = "avatarUrl(size:64) "
  + "open:pullRequests(first:100,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC})"
  + "{nodes{number title url isDraft baseRefName repository{nameWithOwner isPrivate}"
  + " commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}"
  + " merged:pullRequests(first:50,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC})"
  + "{nodes{number title url mergedAt baseRefName repository{nameWithOwner}}}"

function repoParts(projectUrl) {
  var match = String(projectUrl || "").match(/^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/)
  return match ? { owner: match[1], name: match[2] } : null
}

function buildQuery(projectUrl) {
  var parts = repoParts(projectUrl)
  var project = parts ? " project:repository(owner:\"" + parts.owner + "\",name:\"" + parts.name + "\"){viewerHasStarred}" : ""
  return "query{viewer{" + VIEWER_FIELDS + "}" + project + "}"
}


function nextPollSeconds(pollSeconds, failedPolls) {
  var failures = Math.max(0, Math.min(10, Math.floor(Number(failedPolls) || 0)))
  return Math.min(MAX_POLL_SECONDS, clampPollSeconds(pollSeconds) * Math.pow(2, failures))
}

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
      private: node.repository.isPrivate !== false,
      base: String(node.baseRefName || ""),
      sha: commit ? String(commit.oid || "") : "",
      ci: ciState(commit && commit.statusCheckRollup ? commit.statusCheckRollup.state : null)
    })
  }
  return pulls
}

function snapshot(pulls, previous, partialAnswer) {
  var seen = {}
  for (var key in previous || {}) if (previous.hasOwnProperty(key)) seen[key] = previous[key]
  for (var i = 0; i < pulls.length; i++) {
    var pull = pulls[i]
    var unknownInPartialAnswer = partialAnswer && (pull.ci === "none" || pull.sha === "")
    if (unknownInPartialAnswer && seen.hasOwnProperty(pull.key)) continue
    seen[pull.key] = { sha: pull.sha, ci: pull.ci }
  }
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

var PRIVATE_PING_BODY = "A pull request in a private repository\nOpen CI Ping to see which one"

function notification(event) {
  var pull = event.pull
  var body = pull.private ? PRIVATE_PING_BODY : escapeMarkup(pull.repo) + " #" + pull.number + "\n" + escapeMarkup(pull.title)
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
  var icon = failed ? "\u274c" : (counts.passed ? "\u2705" : "\u23f3")
  return [{
    urgency: failed ? "critical" : "normal",
    timeoutMs: failed ? 0 : 8000,
    title: icon + " CI on " + events.length + " pull requests",
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

function listOf(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object" && typeof value.length === "number") {
    var list = []
    for (var i = 0; i < value.length; i++) list.push(value[i])
    return list
  }
  return value ? [value] : []
}

function dismissedList(value) {
  var items = listOf(value)
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
    return { avatarUrl: "" }
  }
  var viewer = data && data.data && data.data.viewer ? data.data.viewer : null
  var avatarUrl = viewer ? String(viewer.avatarUrl || "") : ""
  return { avatarUrl: AVATAR_URL.test(avatarUrl) ? avatarUrl : "" }
}

function repositoryUrl(manifest) {
  var url = manifest ? String(manifest.repository || manifest.homepage || "") : ""
  url = url.replace(/\.git$/, "").replace(/\/$/, "")
  return REPO_URL.test(url) ? url : ""
}

function parseStarred(text) {
  var data
  try {
    data = JSON.parse(text)
  } catch (parseError) {
    return null
  }
  var project = data && data.data ? data.data.project : null
  return project && typeof project.viewerHasStarred === "boolean" ? project.viewerHasStarred : null
}

function starPath(projectUrl) {
  var parts = repoParts(projectUrl)
  return parts ? "/user/starred/" + parts.owner + "/" + parts.name : ""
}

function isPullUrl(url) {
  return PR_URL.test(String(url || ""))
}

function redirectPage(url) {
  var target = isPullUrl(url) ? url : PULLS_URL
  return "<!doctype html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">"
    + "<meta http-equiv=\"refresh\" content=\"0;url=" + escapeMarkup(target) + "\"><title>CI Ping</title>\n"
}
