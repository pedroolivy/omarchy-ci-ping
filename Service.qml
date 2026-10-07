import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

Item {
  id: root

  property var shell: null
  property var manifest: null

  property var settings: ({})
  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null || value === "" ? fallback : value
  }

  readonly property int pollSeconds: Model.clampPollSeconds(setting("pollSeconds", 60))
  readonly property bool notifyStarted: setting("notifyStarted", true) !== false

  readonly property int ghTimeoutSeconds: 45
  readonly property int ghMissingExitCode: 127
  readonly property int ghTimedOutExitCode: 124

  property string status: "loading"
  property string errorText: ""
  property var pulls: []
  property var counts: Model.countByState([])
  property double lastUpdateMs: 0

  property var previousSnapshot: null

  function refresh() {
    if (!poll.running) poll.running = true
  }

  function sendPing(ping) {
    Util.execArgv(["notify-send", "-a", "CI Ping", "-u", ping.urgency, "-t", String(ping.timeoutMs), ping.title, ping.body])
  }

  function acceptAnswer(answerText, partialErrorText) {
    var freshPulls
    try {
      freshPulls = Model.parsePulls(answerText)
    } catch (parseError) {
      return false
    }
    var events = Model.changes(root.previousSnapshot, freshPulls).filter(function(event) {
      return event.kind !== "started" || root.notifyStarted
    })
    var pings = Model.notifications(events)
    for (var i = 0; i < pings.length; i++) root.sendPing(pings[i])
    root.previousSnapshot = Model.snapshot(freshPulls, root.previousSnapshot)
    root.pulls = freshPulls
    root.counts = Model.countByState(freshPulls)
    root.lastUpdateMs = Date.now()
    root.status = partialErrorText ? "partial" : "ok"
    root.errorText = partialErrorText || ""
    return true
  }

  function lastLine(text) {
    return String(text || "").trim().split("\n").pop().slice(0, 160)
  }

  Process {
    id: poll
    command: ["sh", "-c",
              'command -v gh >/dev/null 2>&1 || exit ' + root.ghMissingExitCode + '; exec timeout ' + root.ghTimeoutSeconds + ' gh "$@"',
              "sh", "api", "graphql", "-f", "query=" + Model.QUERY]
    stdout: StdioCollector { id: pollOut; waitForEnd: true }
    stderr: StdioCollector { id: pollErr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        if (!root.acceptAnswer(pollOut.text, "")) {
          root.status = "error"
          root.errorText = "Unexpected answer from GitHub"
        }
        return
      }
      if (exitCode === root.ghMissingExitCode) {
        root.status = "no-gh"
        root.errorText = "GitHub CLI not found: sudo pacman -S github-cli, then gh auth login"
      } else if (exitCode === root.ghTimedOutExitCode) {
        root.status = "error"
        root.errorText = "GitHub did not answer in time"
      } else {
        var reason = root.lastLine(pollErr.text) || "gh failed (exit " + exitCode + ")"
        if (!root.acceptAnswer(pollOut.text, reason)) {
          root.status = "error"
          root.errorText = reason
        }
      }
    }
  }

  Timer {
    interval: root.pollSeconds * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }
}
