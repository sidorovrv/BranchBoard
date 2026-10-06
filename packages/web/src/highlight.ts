import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const MAX_HIGHLIGHTED_CHARACTERS = 30000;

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, powershell, python, ruby, rust, sql, swift, typescript, xml, yaml };

const ALIASES: Record<string, string[]> = {
  bash: ["sh", "zsh", "shell", "console"],
  csharp: ["cs"],
  cpp: ["c++", "cc", "hpp"],
  ini: ["toml"],
  javascript: ["js", "jsx", "mjs", "cjs"],
  json: ["jsonc", "json5"],
  markdown: ["md"],
  powershell: ["ps1", "pwsh"],
  python: ["py"],
  rust: ["rs"],
  typescript: ["ts", "tsx"],
  xml: ["html", "svg", "vue"],
  yaml: ["yml"],
};

Object.entries(LANGUAGES).forEach(([name, definition]) => hljs.registerLanguage(name, definition));
Object.entries(ALIASES).forEach(([name, aliases]) => hljs.registerAliases(aliases, { languageName: name }));

export const highlightCode = (code: string, language: string | undefined): string | undefined => {
  if (!language || code.length > MAX_HIGHLIGHTED_CHARACTERS || !hljs.getLanguage(language.toLowerCase())) return undefined;
  return hljs.highlight(code, { language: language.toLowerCase(), ignoreIllegals: true }).value;
};
