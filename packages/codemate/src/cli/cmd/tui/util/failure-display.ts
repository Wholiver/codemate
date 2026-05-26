export function isRecoverableFailureMessage(message: string | undefined): boolean {
  if (!message) return false
  if (message.startsWith("任务无法继续，需要处理：")) return false
  const recoverableMarkers = [
    "检测到产物路径不符合要求，正在自动修正。",
    "检测到工具调用格式不符合要求，正在调整后重试。",
    "检测到文件写入结果不符合预期，正在重新处理。",
    "当前步骤还没有产生可验证结果，正在重新执行。",
    "审查发现结果仍有不一致之处，正在返回实现阶段修复。",
    "检测到搜索范围过大，正在改用当前任务产物路径验证。",
    "检测到当前步骤结果不符合要求，正在自动调整并重试。",
    "当前子任务未完成，正在按要求路径重新尝试。",
    "工具调用格式有误，正在调整后重试。",
    "当前文件写入操作失败，正在调整写入方式后重试。",
    "文件写入校验失败，正在重新写入并核对。",
    "正在重新审查。",
    "正在修复",
    "正在重新执行",
    "正在自动",
    "后重试",
  ]
  return recoverableMarkers.some((marker) => message.includes(marker))
}
