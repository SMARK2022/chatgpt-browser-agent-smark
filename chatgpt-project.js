'use strict';

/**
 * chatgpt-project.js — 无副作用的 Project / conversation 身份策略
 *
 * 本模块不读取环境变量、浏览器或 registry。core 负责发现和持久化，这里只回答：
 * 一个 URL 是否确实属于 chatgpt.com、哪个 Project，以及是否仍是同一条 conversation。
 * 纯策略可被离线测试直接加载，不会迁移或清理用户的 sessions.json。
 */

const CHATGPT_ORIGIN = 'https://chatgpt.com';

function normalizeProjectKey(value) {
  // Project 名称可包含任意 Unicode 字母/数字；ASCII 白名单会把日文、韩文等名称压成相同空 key。
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** URL slug 只负责导航；只有显式 name 才是经网页发现的标题。 */
function parseProjectRef(value, name) {
  // 完整 URL 必须先通过 origin 校验；裸 token 只允许 g-p- 语法，二者不会共享宽松字符串搜索。
  const input = String(value || '').trim();
  const token = projectToken(input);
  if (!token) return;
  const id = token.match(/^(g-p-[a-z0-9]+)/i)?.[1];
  if (!id) return;
  const titleName = String(name || '').trim() || null;
  const displayName = titleName || token.replace(id, '').replace(/^-/, '') || id;
  return {
    id,
    token,
    key: normalizeProjectKey(titleName || id),
    name: displayName,
    titleName,
    url: `${CHATGPT_ORIGIN}/g/${token}/project`,
  };
}

function projectToken(input) {
  // 看起来像 URL 的输入若解析失败就直接拒绝，不能再降级成“从任意文本里找 g-p-”。
  // pathname 提取与裸 token 正则都要求完整边界，避免 query/hash 或前缀 ID 冒充目标 Project。
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    const url = parseChatGPTURL(input);
    return url?.pathname.match(/^\/g\/(g-p-[^/]+)(?:\/|$)/i)?.[1];
  }
  return input.match(/^(g-p-[a-z0-9]+(?:-[a-z0-9-]+)?)$/i)?.[1];
}

function parseChatGPTURL(value) {
  // 网页 bridge 只信任官方精确 origin；相似域名、非标准端口、userinfo 和 HTTP 都不参与兼容。
  try {
    const url = new URL(value);
    return url.origin === CHATGPT_ORIGIN && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function projectIdFromUrl(value) {
  return parseProjectRef(value)?.id;
}

function isOfficialChatGPTURL(value) {
  return !!parseChatGPTURL(value);
}

function conversationRef(value) {
  // conversation 身份由“可选 Project ID + conversation ID”组成，slug 变化不改变这两个稳定字段。
  // `/c/new` 是创建中的临时入口而非可恢复会话，永远不能写入 session registry。
  const url = parseChatGPTURL(value);
  if (!url) return null;
  const scoped = url.pathname.match(/^\/g\/(g-p-[^/]+)\/c\/([^/]+)\/?$/i);
  if (scoped) {
    const project = parseProjectRef(scoped[1]);
    return project && scoped[2] !== 'new' ? { id: scoped[2], projectID: project.id } : null;
  }
  const plain = url.pathname.match(/^\/c\/([^/]+)\/?$/i);
  return plain && plain[1] !== 'new' ? { id: plain[1], projectID: null } : null;
}

function isChatSessionUrlForProject(url, project, options = {}) {
  const conversation = conversationRef(url);
  if (!conversation) return false;
  return conversation.projectID ? conversation.projectID === project.id : options.allowPlain === true;
}

function isSameConversationUrl(url, expected, project, options = {}) {
  // 历史 plain 兼容也必须保持同一个 conversation ID；它只放宽 Project 前缀，不放宽会话身份。
  const current = conversationRef(url);
  const target = conversationRef(expected);
  if (!current || !target || current.id !== target.id) return false;
  if (target.projectID) return current.projectID === target.projectID && target.projectID === project.id;
  return current.projectID === null && options.allowPlain === true;
}

function isProjectHomeUrlForProject(value, project) {
  // Project 首页和 Project conversation 都含 g-p token，必须再严格限定 `/project` 路径形态。
  const url = parseChatGPTURL(value);
  if (!url || projectIdFromUrl(url.href) !== project.id) return false;
  return /^\/g\/g-p-[^/]+\/project\/?$/i.test(url.pathname);
}

function selectDiscoveredProject(discovered, requested, direct = null) {
  // 空 Unicode key 不参与名称比较；调用者仍可使用精确 ID/token，避免“未知名称匹配第一个候选”。
  if (direct) return discovered.find(project => project.id === direct.id) || direct;
  const key = normalizeProjectKey(requested);
  const matches = discovered.filter(project =>
    (key && (normalizeProjectKey(project.name) === key || project.key === key))
    || project.id === requested
    || project.token === requested
  );
  // 名称匹配到多个身份时，任何“取第一个”都会让文件和提示进入不确定的 Project。
  if (new Set(matches.map(project => project.id)).size > 1) {
    throw new Error(`Multiple ChatGPT projects are named "${requested}"; configure CHATGPT_PROJECT with the exact Project URL or id.`);
  }
  return matches[0] || null;
}

function projectForSessionEntry(entry, fallback) {
  // 自修复只影响新会话；已登记会话始终按自己的 projectURL/projectID 恢复和落盘。
  const stored = parseProjectRef(entry?.projectURL || entry?.projectID, entry?.project);
  return stored && (!entry.projectID || stored.id === entry.projectID) ? stored : fallback;
}

module.exports = Object.freeze({
  normalizeProjectKey,
  parse: parseProjectRef,
  projectIdFromUrl,
  isOfficialURL: isOfficialChatGPTURL,
  conversation: conversationRef,
  acceptsHome: isProjectHomeUrlForProject,
  acceptsConversation: isChatSessionUrlForProject,
  sameConversation: isSameConversationUrl,
  forSession: projectForSessionEntry,
  select: selectDiscoveredProject,
});
