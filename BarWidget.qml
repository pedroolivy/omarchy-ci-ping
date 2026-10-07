import QtQuick
import QtQuick.Effects
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "io.github.pedroolivy.ci-ping"
  manageIpc: false

  property var service: null
  function lookupService() {
    var shell = root.bar && root.bar.shell ? root.bar.shell : null
    var s = shell && typeof shell.serviceFor === "function" ? shell.serviceFor(root.moduleName) : null
    if (s !== service) service = s
  }
  Timer {
    interval: 400
    repeat: true
    running: !root.service
    triggeredOnStart: true
    onTriggered: root.lookupService()
  }
  onBarChanged: lookupService()
  onServiceChanged: pushSettings()
  onSettingsChanged: pushSettings()

  function pushSettings() {
    if (service) service.settings = root.settings || ({})
  }

  function openLink(url) {
    if (root.service) root.service.openLink(url)
    else Util.execArgv(["xdg-open", Model.isPullUrl(url) ? Model.PULLS_URL : url])
    root.close()
  }

  readonly property var pulls: service ? service.pulls : []
  readonly property var merged: service ? service.merged : []
  readonly property var dismissedMerged: root.setting("dismissedMerged", [])
  readonly property double nowMs: service ? service.nowMs : 0
  readonly property var rows: Model.panelRows(pulls, merged, dismissedMerged, nowMs)

  function saveDismissed(pullsToDismiss) {
    var kept = Model.keepDismissed(root.dismissedMerged, root.merged, pullsToDismiss, root.nowMs)
    root.settings = Object.assign({}, root.settings, { dismissedMerged: kept })
    if (root.bar && root.bar.shell) root.bar.shell.updateEntryInline(root.moduleName, root.settings)
  }

  function dismissMerged(pull) {
    root.saveDismissed([pull])
  }

  function dismissAllMerged() {
    root.saveDismissed(Model.visibleMerged(root.merged, root.dismissedMerged, root.nowMs))
  }
  readonly property var counts: service ? service.counts : Model.countByState([])
  readonly property bool failing: counts.failed > 0
  readonly property bool loading: !service || service.status === "loading"
  readonly property bool working: !!service && (service.status === "ok" || pulls.length > 0)
  readonly property string problem: service && service.status !== "ok" && service.status !== "loading" ? service.errorText : ""

  readonly property string label: {
    var text = ""
    if (pulls.length > 0) text += " " + pulls.length
    if (failing) text += " "
    else if (counts.running > 0) text += " 󰔟"
    return text
  }

  readonly property string projectUrl: service ? service.projectUrl : ""
  property string starPhase: "idle"

  readonly property bool starPromptDone: root.setting("starPromptDone", false) === true

  function giveStar() {
    if (root.projectUrl === "" || root.starPhase !== "idle") return
    root.starPhase = "thanks"
    root.settings = Object.assign({}, root.settings, { starPromptDone: true })
    if (root.bar && root.bar.shell) root.bar.shell.updateEntryInline(root.moduleName, root.settings)
    thanksAnimation.restart()
  }

  function openProjectPage() {
    if (root.service) root.service.openLink(root.projectUrl)
    else Util.execArgv(["xdg-open", root.projectUrl])
  }

  readonly property string avatarUrl: service && service.viewer ? service.viewer.avatarUrl : ""
  readonly property bool pingsOn: root.setting("notify", true) !== false

  function togglePings() {
    root.settings = Object.assign({}, root.settings, { notify: !root.pingsOn })
    if (root.bar && root.bar.shell) root.bar.shell.updateEntryInline(root.moduleName, root.settings)
  }

  readonly property string countText: pulls.length === 1 ? "1 open pull request" : pulls.length + " open pull requests"

  readonly property string tooltip: {
    if (loading) return "CI Ping · asking GitHub…"
    var lines = [pulls.length === 0 ? "CI Ping · no open pull requests" : "CI Ping · " + countText]
    if (problem) lines.push(problem)
    if (!pingsOn) lines.push("Pings off")
    if (pulls.length > 0) lines.push("Click to see them")
    return lines.join("\n")
  }

  property var palette: Model.themePalette("")
  readonly property color green: palette.green || Color.popups.text
  readonly property color red: palette.red || Color.urgent
  readonly property color yellow: palette.yellow || Color.accent
  readonly property color purple: palette.purple || Color.accent

  FileView {
    id: themeColors
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.palette = Model.themePalette(text())
    onFileChanged: reload()
  }

  Connections {
    target: Color
    function onForegroundChanged() { themeColors.reload() }
    function onAccentChanged() { themeColors.reload() }
    function onUrgentChanged() { themeColors.reload() }
  }

  function ciColor(ci) {
    if (ci === "failed") return root.red
    if (ci === "running") return root.yellow
    if (ci === "passed") return root.green
    return Color.muted
  }

  property bool pinned: false

  function close() {
    if (root.pinned) return
    root.controller.hide()
  }

  function closeForPopoutSwitch() {
    if (root.pinned) return
    root.popoutSwitchClosing = true
    root.controller.hide()
    Qt.callLater(function() { root.popoutSwitchClosing = false })
  }

  function unpinAndClose() {
    root.pinned = false
    root.controller.hide()
  }

  onOpenedChanged: {
    if (opened && service) service.refresh()
    if (!opened) pinned = false
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.label
    fontSize: Style.font.caption
    horizontalMargin: 6
    active: root.failing
    dimmed: !root.failing && (!root.working || root.pulls.length === 0)
    tooltipText: root.opened ? "" : root.tooltip
    onPressed: function(b) {
      if (b === Qt.RightButton) {
        if (root.service) root.service.refresh()
      } else if (root.pinned) {
        root.unpinAndClose()
      } else {
        root.toggle()
      }
    }
  }

  PopupCard {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    triggerMode: root.pinned ? "hover" : "click"
    contentWidth: popup.fittedContentWidth(Style.space(500))
    contentHeight: popup.fittedContentHeight(column.implicitHeight)

    Column {
      id: column
      width: parent.width
      spacing: Style.space(10)

      Item {
        width: parent.width
        implicitHeight: Math.max(heading.implicitHeight, headingCount.implicitHeight)

        Text {
          id: heading
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "Pull requests"
          color: Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.heading
          font.bold: true
        }

        Row {
          id: headingCount
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(12)

          Text {
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.pulls.length > 0 ? root.pulls.length + " open" : ""
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          Rectangle {
            id: pinToggle
            anchors.verticalCenter: parent.verticalCenter
            implicitWidth: pinToggleRow.implicitWidth + Style.space(14)
            implicitHeight: pinToggleRow.implicitHeight + Style.space(6)
            radius: height / 2
            color: pinToggleArea.containsMouse ? Util.alpha(Color.popups.text, 0.12) : Util.alpha(Color.popups.text, 0.05)
            border.width: 1
            border.color: root.pinned ? Util.alpha(Color.accent, 0.8) : Util.alpha(Color.muted, 0.6)

            Row {
              id: pinToggleRow
              anchors.centerIn: parent
              spacing: Style.space(6)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.pinned ? "\udb81\udc03" : "\udb81\udc04"
                color: root.pinned ? Color.accent : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.body
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.pinned ? "Pinned" : "Pin"
                color: root.pinned ? Color.popups.text : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            MouseArea {
              id: pinToggleArea
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.pinned = !root.pinned
            }
          }

          Rectangle {
            id: pingsToggle
            anchors.verticalCenter: parent.verticalCenter
            implicitWidth: pingsToggleRow.implicitWidth + Style.space(14)
            implicitHeight: pingsToggleRow.implicitHeight + Style.space(6)
            radius: height / 2
            color: pingsToggleArea.containsMouse ? Util.alpha(Color.popups.text, 0.12) : Util.alpha(Color.popups.text, 0.05)
            border.width: 1
            border.color: root.pingsOn ? Util.alpha(root.green, 0.6) : Util.alpha(Color.muted, 0.6)

            Row {
              id: pingsToggleRow
              anchors.centerIn: parent
              spacing: Style.space(6)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.pingsOn ? "\uf0f3" : "\uf1f6"
                color: root.pingsOn ? root.green : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.body
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.pingsOn ? "Pings on" : "Pings off"
                color: root.pingsOn ? Color.popups.text : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            MouseArea {
              id: pingsToggleArea
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.togglePings()
            }
          }

          Item {
            id: avatar
            visible: root.avatarUrl !== "" && avatarImage.status === Image.Ready
            anchors.verticalCenter: parent.verticalCenter
            width: pingsToggle.height
            height: pingsToggle.height

            Rectangle {
              id: avatarMask
              anchors.fill: parent
              radius: width / 2
              color: "white"
              visible: false
              layer.enabled: true
            }

            Image {
              id: avatarImage
              anchors.fill: parent
              source: root.avatarUrl
              sourceSize.width: 64
              sourceSize.height: 64
              fillMode: Image.PreserveAspectCrop
              asynchronous: true
              smooth: true
              layer.enabled: true
              layer.smooth: true
              layer.effect: MultiEffect {
                maskEnabled: true
                maskSource: avatarMask
                maskThresholdMin: 0.5
                maskSpreadAtMin: 1.0
              }
            }

            Rectangle {
              anchors.fill: parent
              radius: width / 2
              color: "transparent"
              border.width: 1
              border.color: Util.alpha(Color.popups.text, 0.25)
            }
          }
        }
      }

      Text {
        visible: root.problem !== ""
        width: parent.width
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        text: root.problem
        color: Color.urgent
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        visible: root.pulls.length === 0
        width: parent.width
        textFormat: Text.PlainText
        text: root.loading ? "Asking GitHub…" : "No open pull requests"
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.body
      }

      ListView {
        id: list
        visible: root.rows.length > 0
        width: parent.width
        height: Math.min(contentHeight, Style.space(460))
        clip: true
        spacing: Style.space(2)
        boundsBehavior: Flickable.StopAtBounds
        model: root.rows

        delegate: Item {
          id: entry
          required property var modelData
          readonly property bool isHeader: modelData.kind === "header"
          readonly property bool isMerged: modelData.kind === "merged"
          readonly property var pull: modelData.pull
          width: list.width
          height: isHeader ? mergedHeader.implicitHeight + Style.space(16) : rowText.implicitHeight + Style.space(14)

          Item {
            id: mergedHeader
            visible: entry.isHeader
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(10)
            anchors.bottomMargin: Style.space(4)
            implicitHeight: mergedHeaderLabel.implicitHeight

            Text {
              id: mergedHeaderLabel
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Merged in the last 24 hours"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }

            Text {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Clear"
              color: clearArea.containsMouse ? Color.popups.text : Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption

              MouseArea {
                id: clearArea
                anchors.fill: parent
                anchors.margins: -Style.space(4)
                enabled: entry.isHeader
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.dismissAllMerged()
              }
            }
          }

          Rectangle {
            visible: !entry.isHeader
            anchors.fill: parent
            radius: Style.space(6)
            color: rowHover.hovered ? Util.alpha(Color.popups.text, 0.1) : "transparent"

            Behavior on color { ColorAnimation { duration: 90 } }
          }

          Text {
            id: rowIcon
            visible: !entry.isHeader
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(20)
            horizontalAlignment: Text.AlignHCenter
            textFormat: Text.PlainText
            text: entry.isHeader ? "" : (entry.isMerged ? Model.PULL_ICON_MERGED : Model.pullIcon(entry.pull))
            color: entry.isMerged ? root.purple : (entry.pull && entry.pull.draft ? Color.muted : root.green)
            font.family: Style.font.family
            font.pixelSize: Style.font.iconLarge
          }

          Column {
            id: rowText
            visible: !entry.isHeader
            anchors.left: rowIcon.right
            anchors.leftMargin: Style.space(10)
            anchors.right: entry.isMerged ? dismissButton.left : ciBadge.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              width: parent.width
              elide: Text.ElideRight
              textFormat: Text.PlainText
              text: entry.pull ? entry.pull.title : ""
              color: entry.isMerged ? Util.alpha(Color.popups.text, 0.75) : Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              width: parent.width
              elide: Text.ElideRight
              textFormat: Text.PlainText
              text: !entry.pull ? "" : (entry.isMerged ? Model.mergedSubtitle(entry.pull, root.nowMs) : Model.pullSubtitle(entry.pull))
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          HoverHandler {
            id: rowHover
            enabled: !entry.isHeader
            cursorShape: Qt.PointingHandCursor
          }

          MouseArea {
            anchors.fill: parent
            enabled: !entry.isHeader
            onClicked: root.openLink(Model.openUrl(entry.pull))
          }

          Row {
            id: ciBadge
            visible: !entry.isHeader && !entry.isMerged
            anchors.right: parent.right
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            Text {
              visible: text !== ""
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: entry.pull && !entry.isMerged ? Model.CI_MARK[entry.pull.ci] : ""
              color: entry.pull ? root.ciColor(entry.pull.ci) : Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: entry.pull && !entry.isMerged ? Model.CI_LABEL[entry.pull.ci] : ""
              color: entry.pull ? root.ciColor(entry.pull.ci) : Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          Rectangle {
            id: dismissButton
            visible: entry.isMerged
            anchors.right: parent.right
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(24)
            height: Style.space(24)
            radius: width / 2
            color: dismissArea.containsMouse ? Util.alpha(Color.popups.text, 0.15) : "transparent"

            Text {
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: ""
              color: dismissArea.containsMouse ? Color.popups.text : Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            MouseArea {
              id: dismissArea
              anchors.fill: parent
              enabled: entry.isMerged
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.dismissMerged(entry.pull)
            }
          }
        }
      }

      Item {
        width: parent.width
        implicitHeight: Math.max(checkedAt.implicitHeight, openAll.implicitHeight)

        Text {
          id: checkedAt
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: root.service && root.service.lastUpdateMs > 0
            ? "Checked at " + Qt.formatTime(new Date(root.service.lastUpdateMs), "hh:mm") : ""
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        Item {
          id: starArea
          property real sparkProgress: 0
          visible: root.projectUrl !== "" && (root.starPhase === "thanks"
            || (root.starPhase === "idle" && !root.starPromptDone && root.service !== null && root.service.projectStarred === false))
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(starButton.implicitWidth, thanksRow.implicitWidth)
          height: Math.max(starButton.implicitHeight, thanksRow.implicitHeight)

          Text {
            id: starButton
            visible: root.starPhase === "idle"
            anchors.centerIn: parent
            textFormat: Text.PlainText
            text: " Star on GitHub"
            color: starHover.hovered && root.starPhase === "idle" ? root.yellow : Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption

            HoverHandler {
              id: starHover
              cursorShape: root.starPhase === "idle" ? Qt.PointingHandCursor : Qt.ArrowCursor
            }

            TapHandler {
              enabled: root.starPhase === "idle"
              onTapped: root.giveStar()
            }
          }

          Row {
            id: thanksRow
            visible: root.starPhase === "thanks"
            anchors.centerIn: parent
            spacing: Style.space(6)
            opacity: 0

            Text {
              id: thanksStar
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: ""
              color: root.yellow
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              scale: 0
              rotation: -120
            }

            Text {
              id: thanksText
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Thanks for checking it out!"
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              opacity: 0
            }

            Text {
              id: thanksHeart
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: ""
              color: root.red
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              opacity: 0
              scale: 0.4
            }
          }

          Repeater {
            model: 8

            Text {
              required property int index
              readonly property real angle: index * Math.PI / 4
              readonly property real centerX: thanksRow.x + thanksStar.x + thanksStar.width / 2
              readonly property real centerY: thanksRow.y + thanksStar.y + thanksStar.height / 2
              visible: root.starPhase === "thanks" && starArea.sparkProgress > 0 && starArea.sparkProgress < 1
              x: centerX + Math.cos(angle) * starArea.sparkProgress * Style.space(18) - width / 2
              y: centerY + Math.sin(angle) * starArea.sparkProgress * Style.space(18) - height / 2
              opacity: 1 - starArea.sparkProgress
              textFormat: Text.PlainText
              text: ""
              color: index % 2 === 0 ? root.yellow : Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Math.max(6, Style.font.caption - 3)
            }
          }

          SequentialAnimation {
            id: thanksAnimation
            ScriptAction {
              script: {
                thanksRow.opacity = 1
                thanksStar.scale = 0
                thanksStar.rotation = -120
                thanksText.opacity = 0
                thanksHeart.opacity = 0
                thanksHeart.scale = 0.4
                starArea.sparkProgress = 0
              }
            }
            ParallelAnimation {
              NumberAnimation { target: thanksStar; property: "scale"; to: 1.6; duration: 260; easing.type: Easing.OutBack }
              NumberAnimation { target: thanksStar; property: "rotation"; to: 0; duration: 420; easing.type: Easing.OutCubic }
              NumberAnimation { target: starArea; property: "sparkProgress"; from: 0; to: 1; duration: 700; easing.type: Easing.OutCubic }
              SequentialAnimation {
                PauseAnimation { duration: 260 }
                NumberAnimation { target: thanksStar; property: "scale"; to: 1; duration: 200; easing.type: Easing.InOutQuad }
              }
            }
            NumberAnimation { target: thanksText; property: "opacity"; to: 1; duration: 220 }
            ParallelAnimation {
              NumberAnimation { target: thanksHeart; property: "opacity"; to: 1; duration: 200 }
              NumberAnimation { target: thanksHeart; property: "scale"; to: 1.3; duration: 200; easing.type: Easing.OutBack }
            }
            NumberAnimation { target: thanksHeart; property: "scale"; to: 1; duration: 160 }
            PauseAnimation { duration: 500 }
            ScriptAction { script: root.openProjectPage() }
            PauseAnimation { duration: 1700 }
            NumberAnimation { target: thanksRow; property: "opacity"; to: 0; duration: 450 }
            ScriptAction { script: root.starPhase = "done" }
          }
        }

        Text {
          id: openAll
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "All on GitHub "
          color: openAllHover.hovered ? Color.popups.text : Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption

          HoverHandler {
            id: openAllHover
            cursorShape: Qt.PointingHandCursor
          }

          TapHandler {
            onTapped: root.openLink(Model.PULLS_URL)
          }
        }
      }
    }
  }
}
