/**
 * Attaches to a chat, spawns a pty, attaches it to the terminal emulator
 * and the renderer and manages them. Handles incoming commands & input,
 * and posts complimentary messages such as command itself and output code.
 **/

var util = require("util");
var escapeHtml = require("escape-html");
var pty = require("pty.js");
var utils = require("./utils");
var terminal = require("./terminal");
var renderer = require("./renderer");

function Command(reply, context, command) {
  this.reply = reply;
  this.command = command;
  this.pty = pty.spawn(context.shell, ["-c", command], {
    cols: context.size.columns,
    rows: context.size.rows,
    cwd: context.cwd,
    env: context.env,
  }); //FIXME: disable ISIG, ICANON, IEXTEN
  this.terminal = terminal.createTerminal({
    columns: context.size.columns,
    rows: context.size.rows,
  });
  this.state = this.terminal.state;
  this.renderer = new renderer.Renderer(reply, this.state, {
    cursorString: "\uD83D\uDD38",
    cursorBlinkString: "\uD83D\uDD38",
    hidePreview: !context.linkPreviews,
    unfinishedHidePreview: true,
    silent: context.silent,
    unfinishedSilent: true,
    maxLinesWait: 20,
    maxLinesEmitted: 30,
    lineTime: 400,
    chunkTime: 3000,
    editTime: 200,
    unfinishedTime: 1000,
    startFill: "·  ",
  });
  this._initKeypad();
  //FIXME: reduce rate when talking to supergroups (and maybe groups?)

  // Post initial message
  this.initialMessage = new utils.EditedMessage(reply, this._renderInitial(), "HTML");

  // Process command output
  this.pty.on("data", this._ptyData.bind(this));

  // Handle command exit
  this.pty.on("exit", this._exit.bind(this));
}
util.inherits(Command, require("events").EventEmitter);

Command.prototype._renderInitial = function _renderInitial() {
  var content = "", title = this.state.metas.title;
  if (title) {
    content += "<strong>" + escapeHtml(title) + "</strong>\n";
    content += "<strong>$</strong> " + escapeHtml(this.command);
  } else {
    content += "<strong>$ " + escapeHtml(this.command) + "</strong>";
  }
  return content;
}

Command.prototype._ptyData = function _ptyData(chunk) {
  //FIXME: implement some backpressure, for example, read smaller chunks, stop reading if there are >= 20 lines waiting to be pushed, set the HWM
  if ((typeof chunk !== "string") && !(chunk instanceof String))
    throw new Error("Expected a String, you liar.");
  this.terminal.write(chunk, "utf-8", this._update.bind(this));
};

Command.prototype._update = function _update() {
  this.initialMessage.edit(this._renderInitial());
  this.renderer.update();
};

Command.prototype.resize = function resize(size) {
  this.state.resize(size);
  this._update();
  this.pty.resize(size.columns, size.rows);
};

Command.prototype.redraw = function redraw() {
  this.pty.redraw();
};

Command.prototype.sendSignal = function sendSignal(signal, group) {
  var pid = this.pty.pid;
  if (group) pid = -pid;
  process.kill(pid, signal);
};

Command.prototype.sendEof = function sendEof() {
  //FIXME: enable ICANON, write KILL character, restore
  this.pty.write("\x04");
};

Command.prototype._exit = function _exit(code, signal) {
  this._update();
  this.renderer.flushUnfinished();

  //FIXME: could wait until all edits are made before posting exited message
  var exitedText;
  if (signal)
    exitedText = "\uD83D\uDC80 <strong>Killed</strong> by "+utils.formatSignal(signal)+".";
  else if (code === 0)
    exitedText = "\u2705 <strong>Exited</strong> correctly.";
  else
    exitedText = "\u26D4 <strong>Exited</strong> with "+code+".";
  this.reply.html(exitedText);

  this._removeKeypad();
  this.emit("exit");
};

Command.prototype.handleReply = function handleReply(msg) {
  //FIXME: feature: if photo, file, video, voice or music, put the terminal in raw mode, hold off further input, pipe binary asset to terminal, restore
  //Flags we would need to touch: -INLCR -IGNCR -ICRNL -IUCLC -ISIG -ICANON -IEXTEN, and also for convenience -ECHO -ECHONL

  if (msg.type !== "text") return false;
  this.sendInput(msg.text);
};

Command.prototype.sendInput = function sendInput(text, noTerminate) {
  text = text.replace(/\n/g, "\r");
  if (!noTerminate) text += "\r";
  this.pty.write(text);
};

Command.prototype.setSilent = function setSilent(silent) {
  this.renderer.options.silent = silent;
};

Command.prototype.setLinkPreviews = function setLinkPreviews(linkPreviews) {
  this.renderer.options.hidePreview = !linkPreviews;
};

Command.prototype._initKeypad = function _initKeypad() {
  this.keypadToken = utils.generateToken();

  var keys = {
    esc:       { label: "ESC", content: "\x1b" },
    tab:       { label: "⇥", content: "\t" },
    enter:     { label: "⏎", content: "\r" },
    backspace: { label: "↤", content: "\x7F" },
    space:     { label: " ", content: " " },

    up:        { label: "↑", content: "\x1b[A", appKeypadContent: "\x1bOA" },
    down:      { label: "↓", content: "\x1b[B", appKeypadContent: "\x1bOB" },
    right:     { label: "→", content: "\x1b[C", appKeypadContent: "\x1bOC" },
    left:      { label: "←", content: "\x1b[D", appKeypadContent: "\x1bOD" },

    insert:    { label: "INS", content: "\x1b[2~" },
    del:       { label: "DEL", content: "\x1b[3~" },
    home:      { label: "⇱", content: "\x1bOH" },
    end:       { label: "⇲", content: "\x1bOF" },

    prevPage:  { label: "⇈", content: "\x1b[5~" },
    nextPage:  { label: "⇊", content: "\x1b[6~" },
  };

  var keypad = [
    [ "esc",  "up",    "backspace", "del"  ],
    [ "left", "space", "right",     "home" ],
    [ "tab",  "down",  "enter",     "end"  ],
  ];

  this.buttons = [];
  this.inlineKeyboard = keypad.map(function (row) {
    return row.map(function (name) {
      var button = keys[name];
      var data = JSON.stringify({ token: this.keypadToken, button: this.buttons.length });
      var keyboardButton = { text: button.label, callback_data: data };
      this.buttons.push(button);
      return keyboardButton;
    }.bind(this));
  }.bind(this));

  this.reply.bot.callback(function (query, next) {
    try {
      var data = JSON.parse(query.data);
    } catch (e) { return next(); }
    if (data.token !== this.keypadToken) return next();
    this._keypadPressed(data.button, query);
  }.bind(this));
};

Command.prototype.toggleKeypad = function toggleKeypad() {
  if (this.keypadMessage) {
    this.keypadMessage.markup = null;
    this.keypadMessage.refresh();
    this.keypadMessage = null;
    return;
  }

  // FIXME: this is pretty badly implemented, we should wait until last message (or message with cursor) has known id
  var messages = this.renderer.messages;
  var msg = messages[messages.length - 1].ref;
  msg.markup = {inline_keyboard: this.inlineKeyboard};
  msg.refresh();
  this.keypadMessage = msg;
};

Command.prototype._keypadPressed = function _keypadPressed(id, query) {
  if (typeof id !== "number" || !(id in this.buttons)) return;
  var button = this.buttons[id];
  var content = button.content;
  if (button.appKeypadContent !== undefined && this.state.getMode("appKeypad"))
    content = button.appKeypadContent;
  this.pty.write(content);
  query.answer();
};

Command.prototype._removeKeypad = function _removeKeypad() {
  if (this.keypadMessage) this.toggleKeypad();
};



exports.Command = Command;