import QtQuick
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
    Util.execArgv(["xdg-open", url])
    root.close()
  }

  readonly property var pulls: service ? service.pulls : []
  readonly property var rows: Model.sortForPanel(pulls)
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

  readonly property string countText: pulls.length === 1 ? "1 open pull request" : pulls.length + " open pull requests"

  readonly property string tooltip: {
    if (loading) return "CI Ping · asking GitHub…"
    var lines = [pulls.length === 0 ? "CI Ping · no open pull requests" : "CI Ping · " + countText]
    if (problem) lines.push(problem)
    if (pulls.length > 0) lines.push("Click to see them")
    return lines.join("\n")
  }

  property var palette: Model.themePalette("")
  readonly property color green: palette.green || Color.popups.text
  readonly property color red: palette.red || Color.urgent
  readonly property color yellow: palette.yellow || Color.accent

  FileView {
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.palette = Model.themePalette(text())
    onFileChanged: reload()
  }

  function ciColor(ci) {
    if (ci === "failed") return root.red
    if (ci === "running") return root.yellow
    if (ci === "passed") return root.green
    return Color.muted
  }

  onOpenedChanged: if (opened && service) service.refresh()

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
    contentWidth: popup.fittedContentWidth(Style.space(440))
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

        Text {
          id: headingCount
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: root.pulls.length > 0 ? root.pulls.length + " open" : ""
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.body
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
        visible: root.rows.length === 0
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
        height: Math.min(contentHeight, Style.space(420))
        clip: true
        spacing: Style.space(2)
        boundsBehavior: Flickable.StopAtBounds
        model: root.rows

        delegate: Rectangle {
          id: row
          required property var modelData
          width: list.width
          height: rowText.implicitHeight + Style.space(14)
          radius: Style.space(6)
          color: rowHover.hovered ? Util.alpha(Color.popups.text, 0.1) : "transparent"

          Behavior on color { ColorAnimation { duration: 90 } }

          Text {
            id: rowIcon
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(20)
            horizontalAlignment: Text.AlignHCenter
            textFormat: Text.PlainText
            text: Model.pullIcon(row.modelData)
            color: row.modelData.draft ? Color.muted : root.green
            font.family: Style.font.family
            font.pixelSize: Style.font.iconLarge
          }

          Column {
            id: rowText
            anchors.left: rowIcon.right
            anchors.leftMargin: Style.space(10)
            anchors.right: ciBadge.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              width: parent.width
              elide: Text.ElideRight
              textFormat: Text.PlainText
              text: row.modelData.title
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              width: parent.width
              elide: Text.ElideRight
              textFormat: Text.PlainText
              text: Model.pullSubtitle(row.modelData)
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          Row {
            id: ciBadge
            anchors.right: parent.right
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            Text {
              visible: text !== ""
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: Model.CI_MARK[row.modelData.ci]
              color: root.ciColor(row.modelData.ci)
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: Model.CI_LABEL[row.modelData.ci]
              color: root.ciColor(row.modelData.ci)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          HoverHandler {
            id: rowHover
            cursorShape: Qt.PointingHandCursor
          }

          TapHandler {
            onTapped: root.openLink(Model.openUrl(row.modelData))
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
