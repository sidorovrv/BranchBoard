import addComment from "@material-symbols/svg-400/rounded/add_comment.svg";
import attachFile from "@material-symbols/svg-400/rounded/attach_file.svg";
import deleteIcon from "@material-symbols/svg-400/rounded/delete.svg";
import description from "@material-symbols/svg-400/rounded/description.svg";
import edit from "@material-symbols/svg-400/rounded/edit.svg";
import forkRight from "@material-symbols/svg-400/rounded/fork_right.svg";
import layers from "@material-symbols/svg-400/rounded/layers.svg";
import lock from "@material-symbols/svg-400/rounded/lock.svg";
import redo from "@material-symbols/svg-400/rounded/redo.svg";
import refresh from "@material-symbols/svg-400/rounded/refresh.svg";
import search from "@material-symbols/svg-400/rounded/search.svg";
import add from "@material-symbols/svg-400/rounded/add.svg";
import createNewFolder from "@material-symbols/svg-400/rounded/create_new_folder.svg";
import folder from "@material-symbols/svg-400/rounded/folder.svg";
import leftPanelClose from "@material-symbols/svg-400/rounded/left_panel_close.svg";
import leftPanelOpen from "@material-symbols/svg-400/rounded/left_panel_open.svg";
import rightPanelClose from "@material-symbols/svg-400/rounded/right_panel_close.svg";
import rightPanelOpen from "@material-symbols/svg-400/rounded/right_panel_open.svg";
import save from "@material-symbols/svg-400/rounded/save.svg";
import settings from "@material-symbols/svg-400/rounded/settings.svg";
import stickyNote from "@material-symbols/svg-400/rounded/sticky_note_2.svg";
import stop from "@material-symbols/svg-400/rounded/stop.svg";
import subdirectoryArrowRight from "@material-symbols/svg-400/rounded/subdirectory_arrow_right.svg";
import undo from "@material-symbols/svg-400/rounded/undo.svg";
import unfoldLess from "@material-symbols/svg-400/rounded/unfold_less.svg";
import unfoldMore from "@material-symbols/svg-400/rounded/unfold_more.svg";
import arrowUpward from "@material-symbols/svg-400/rounded/arrow_upward.svg";
import keyboardArrowDown from "@material-symbols/svg-400/rounded/keyboard_arrow_down.svg";
import neurology from "@material-symbols/svg-400/rounded/neurology.svg";
import shield from "@material-symbols/svg-400/rounded/shield.svg";
import smartToy from "@material-symbols/svg-400/rounded/smart_toy.svg";
import accountTree from "@material-symbols/svg-400/rounded/account_tree.svg";
import checkBox from "@material-symbols/svg-400/rounded/check_box.svg";
import checkBoxOutlineBlank from "@material-symbols/svg-400/rounded/check_box_outline_blank.svg";
import close from "@material-symbols/svg-400/rounded/close.svg";
import historyIcon from "@material-symbols/svg-400/rounded/history.svg";
import darkMode from "@material-symbols/svg-400/rounded/dark_mode.svg";
import deleteForever from "@material-symbols/svg-400/rounded/delete_forever.svg";
import keep from "@material-symbols/svg-400/rounded/keep.svg";
import keepOff from "@material-symbols/svg-400/rounded/keep_off.svg";
import menuBook from "@material-symbols/svg-400/rounded/menu_book.svg";
import monitorHeart from "@material-symbols/svg-400/rounded/monitor_heart.svg";
import pending from "@material-symbols/svg-400/rounded/pending.svg";
import restoreFromTrash from "@material-symbols/svg-400/rounded/restore_from_trash.svg";
import summarize from "@material-symbols/svg-400/rounded/summarize.svg";
import toll from "@material-symbols/svg-400/rounded/toll.svg";
import code from "@material-symbols/svg-400/rounded/code.svg";
import difference from "@material-symbols/svg-400/rounded/difference.svg";
import keyboardArrowRight from "@material-symbols/svg-400/rounded/keyboard_arrow_right.svg";
import download from "@material-symbols/svg-400/rounded/download.svg";
import upload from "@material-symbols/svg-400/rounded/upload.svg";
import dragIndicator from "@material-symbols/svg-400/rounded/drag_indicator.svg";
import zoomIn from "@material-symbols/svg-400/rounded/zoom_in.svg";
import contentCopy from "@material-symbols/svg-400/rounded/content_copy.svg";
import check from "@material-symbols/svg-400/rounded/check.svg";
import tune from "@material-symbols/svg-400/rounded/tune.svg";
import psychology from "@material-symbols/svg-400/rounded/psychology.svg";
import palette from "@material-symbols/svg-400/rounded/palette.svg";
import keyboard from "@material-symbols/svg-400/rounded/keyboard.svg";
import fileOpen from "@material-symbols/svg-400/rounded/file_open.svg";
import folderOpen from "@material-symbols/svg-400/rounded/folder_open.svg";
import type { CSSProperties } from "react";

const ICON_URLS = {
  reply: subdirectoryArrowRight,
  branch: forkRight,
  edit,
  regenerate: refresh,
  stop,
  assemble: layers,
  collapse: unfoldLess,
  expand: unfoldMore,
  delete: deleteIcon,
  plus: addComment,
  note: stickyNote,
  search,
  undo,
  redo,
  paperclip: attachFile,
  file: description,
  lock,
  settings,
  add,
  addProject: createNewFolder,
  folder,
  sidebarOpen: leftPanelOpen,
  sidebarClose: leftPanelClose,
  contextPanelOpen: rightPanelOpen,
  contextPanelClose: rightPanelClose,
  save,
  send: arrowUpward,
  chevronDown: keyboardArrowDown,
  chevronRight: keyboardArrowRight,
  code,
  edited: difference,
  model: smartToy,
  effort: neurology,
  permission: shield,
  pin: keep,
  unpin: keepOff,
  summary: summarize,
  trash: restoreFromTrash,
  purge: deleteForever,
  reader: menuBook,
  health: monitorHeart,
  budget: toll,
  todoDone: checkBox,
  todoOpen: checkBoxOutlineBlank,
  todoActive: pending,
  subagent: accountTree,
  close,
  history: historyIcon,
  download,
  upload,
  dragHandle: dragIndicator,
  zoom: zoomIn,
  theme: darkMode,
  copy: contentCopy,
  check,
  tune,
  psychology,
  palette,
  keyboard,
  extract: fileOpen,
  reveal: folderOpen,
};

export type IconName = keyof typeof ICON_URLS;

export const Icon = ({ name }: { name: IconName }) => <span className="icon" style={{ "--icon": `url("${ICON_URLS[name]}")` } as CSSProperties} aria-hidden="true" />;

export const IconRow = ({ names }: { names: IconName[] }) => (
  <span className="icon-row">
    {names.map((name) => <Icon key={name} name={name} />)}
  </span>
);
