import { View, Text, Image, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { CircleUser, LogIn, LogOut, Pencil, Inbox, BookOpen, Plus, HardDrive, Bot } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyCard } from '@/components/filter-header'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import QrLoginModal from '@/components/qr-login-modal'
import {
  getAuthState, isLoggedIn, promptLogin, logout, fetchMe, updateProfile,
  type AuthState,
} from '@/services/auth'
import {
  fetchOverview, fetchStorageUsage, formatBytes, purgeAccount,
  type Overview, type StorageUsage,
} from '@/services/api'
import { INK, BRAND_FOREGROUND } from '@/lib/theme'
import { ensureAiSetting, peekAiEnabled, updateAiEnabled } from '@/services/ai-settings'
import { AI_PUBLIC_ENTRY, APP_NAME, ICP_FILING_NO } from '@/constants/app-info'

/**
 * 我的：登录 / 退出 / 资料 / 账号信息
 * 匿名身份也能进本页，只是提示「登录以同步数据」
 */
export default function ProfilePage() {
  const [state, setState] = useState<AuthState | null>(getAuthState())
  const [overview, setOverview] = useState<Overview | null>(null)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState('')
  /** H5 扫码登录弹层（电脑浏览器无 wx.login，思傅 2026-10-20 拍板方案） */
  const [qrVisible, setQrVisible] = useState(false)
  /** AI 外发开关（R-合规-02）：默认关 = 仅本地，任何内容不出机器 */
  const [aiEnabled, setAiEnabledState] = useState(peekAiEnabled())

  /** 打开隐私政策（R-合规-03） */
  const openPolicy = () => Taro.navigateTo({ url: '/pages/privacy/index' })
  /** 打开用户协议（提审要求与隐私政策齐备） */
  const openAgreement = () => Taro.navigateTo({ url: '/pages/agreement/index' })

  /**
   * 切换「AI 与在线检索」开关（R-合规-02）。
   * 打开方向必须二次确认：这一步等于监护人同意把孩子的题目发往第三方。
   * 关闭方向不确认——收紧权限不需要征求同意。
   */
  const handleToggleAi = async (next: boolean) => {
    if (busy) return
    if (next) {
      const r = await Taro.showModal({
        title: '开启 AI 与在线检索',
        content:
          '开启后，题目文字与图片会发送给第三方 AI 服务（在线搜题、知识库检索、大模型解题）用于给出答案与讲解。\n\n' +
          '不开启时：识别在本机完成，答案只在本地题库里找，任何内容都不会离开设备。\n\n' +
          '可随时回来关闭。',
        confirmText: '同意开启',
        cancelText: '继续仅本地',
      })
      if (!r.confirm) return
    }
    setBusy(true)
    try {
      const v = await updateAiEnabled(next)
      setAiEnabledState(v)
      Taro.showToast({ title: v ? '已开启 AI 与在线检索' : '已切换为仅本地模式', icon: 'none' })
    } catch (e) {
      console.error('[profile] 保存 AI 开关失败', e)
      Taro.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 注销账号（R-合规-03）。
   * 先 dry-run 拿「会删什么、留什么」，把代价写清楚再让用户确认——
   * 不先展示会删多少就弹「确定删除？」是不负责任的：这是不可恢复操作。
   */
  const handlePurge = async () => {
    try {
      const plan = await purgeAccount(true)
      const rows = plan.rowsDeleted || {}
      const detail = Object.entries(rows)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t} ${n} 行`)
        .join('、')
      const r = await Taro.showModal({
        title: '注销账号（不可恢复）',
        content:
          `将删除你的账号与本人数据${detail ? `（${detail}）` : ''}，图片/文档共 ${plan.blobsTotal} 个文件。` +
          (plan.blobsKeptForOtherUsers > 0
            ? `其中 ${plan.blobsKeptForOtherUsers} 个因其他账号也在使用而保留（内容相同，删了会影响别人）。`
            : '') +
          '跨用户共享的识别缓存不随账号删除。注销后无法恢复，确认继续？',
        confirmText: '注销',
        confirmColor: '#B3261E',
      })
      if (!r.confirm) return
      await purgeAccount(false)
      try {
        Taro.removeStorageSync('gk_auth_token')
        Taro.removeStorageSync('gk_user_id')
      } catch {
        /* ignore */
      }
      Taro.showToast({ title: '已注销', icon: 'success' })
      setTimeout(() => Taro.reLaunch({ url: '/pages/index/index' }), 800)
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || '注销失败', icon: 'none' })
    }
  }

  const load = async () => {
    setState(getAuthState())
    try {
      const ov = await fetchOverview()
      setOverview(ov)
    } catch {
      /* 概览失败不影响本页 */
    }
    // 存储配额（策略 6）；拿不到就整块不展示，不影响本页其余功能
    const u = await fetchStorageUsage()
    setUsage(u)
    // 有本地身份时向服务端校验一次（失效则降级为未登录）
    if (getAuthState()) {
      try {
        const user = await fetchMe()
        setState({ userId: user.id, nickname: user.nickname || '', avatarUrl: user.avatar_url || '', isAnonymous: !!user.is_anonymous })
      } catch {
        /* 校验失败保留本地展示 */
      }
    }
  }

  useDidShow(() => {
    load()
    // 开关可能被别的入口改过（例如隐私页），回到本页时对齐一次
    void ensureAiSetting().then(setAiEnabledState)
  })

  const handleLogin = async () => {
    // H5（电脑浏览器）：没有 wx.login，改走扫码登录弹层
    if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
      setQrVisible(true)
      return
    }
    setBusy(true)
    const ok = await promptLogin()
    setBusy(false)
    if (ok) load()
  }

  const handleLogout = () => {
    Taro.showModal({
      title: '退出登录',
      content: '退出后本机将回到未登录状态（原有记录保留在账号里，重新登录即可恢复）。',
      success: async (r) => {
        if (!r.confirm) return
        await logout()
        Taro.showToast({ title: '已退出', icon: 'success' })
        load()
      },
    })
  }

  const handleEditNickname = () => {
    setNickname(state?.nickname || '')
    setEditing(true)
  }

  const handleSaveNickname = async () => {
    const name = nickname.trim()
    if (!name) {
      Taro.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    setBusy(true)
    try {
      const user = await updateProfile({ nickname: name })
      setState({ userId: user.id, nickname: user.nickname || '', avatarUrl: user.avatar_url || '', isAnonymous: !!user.is_anonymous })
      setEditing(false)
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '保存失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const logged = isLoggedIn()

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      <QrLoginModal
        visible={qrVisible}
        onClose={() => setQrVisible(false)}
        onSuccess={() => {
          setQrVisible(false)
          load()
        }}
      />
      {/* 说明：本页无 fixed 头部，H5 下靠 app.css 的 .taro_scroll_view_core
          paddingTop 补偿把内容顶到内置导航栏下方 */}
      <ScrollView scrollY style={{ height: '100vh', paddingTop: 44 }}>
        <View className="px-4 pt-6 pb-16">
          {/* 头像 + 身份 */}
          <View className="flex flex-row items-center gap-4 mb-5">
            {state?.avatarUrl ? (
              <Image
                src={state.avatarUrl}
                className="rounded-full border border-border"
                style={{ width: '64px', height: '64px' }}
                mode="aspectFill"
              />
            ) : (
              <View className="rounded-full bg-muted flex items-center justify-center" style={{ width: '64px', height: '64px' }}>
                <CircleUser size={36} color="#9A948A" />
              </View>
            )}
            <View className="flex-1">
              <View className="flex flex-row items-center gap-2">
                <Text className="block text-lg font-bold text-foreground">
                  {state?.nickname || (logged ? '微信用户' : '未登录')}
                </Text>
                {logged && (
                  <Text className="block text-xs text-primary rounded-lg border border-border px-2 py-1" onClick={handleEditNickname}>
                    编辑
                  </Text>
                )}
              </View>
              <Text className="block text-xs text-muted-foreground mt-1">
                {logged ? '已登录（数据云端同步）' : '匿名使用中（本机数据保留 30 天）'}
              </Text>
            </View>
          </View>

          {editing && (
            <Card className="rounded-2xl border-border p-4 mb-5">
              <View className="flex flex-row items-center gap-2">
                <View className="flex-1 border border-border rounded-xl px-3 py-2">
                  <Input
                    value={nickname}
                    placeholder="输入昵称"
                    onInput={(e) => setNickname(e.detail.value)}
                  />
                </View>
                <Button className="h-10 rounded-xl" disabled={busy} onClick={handleSaveNickname}>
                  <Text className="block text-sm">保存</Text>
                </Button>
                <Button variant="outline" className="h-10 rounded-xl" onClick={() => setEditing(false)}>
                  <Text className="block text-sm">取消</Text>
                </Button>
              </View>
            </Card>
          )}

          {/* 登录 / 退出 */}
          <Card className="rounded-2xl border-border p-4 mb-5">
            {logged ? (
              <>
                <Text className="block text-sm font-semibold text-foreground mb-2">账号</Text>
                <Text className="block text-xs text-muted-foreground mb-4">
                  你的题目、复习本与资料已与微信账号绑定，换设备登录即可找回。
                </Text>
                <Button variant="outline" className="w-full h-11 rounded-xl" disabled={busy} onClick={handleLogout}>
                  <LogOut size={16} color={INK} />
                  <Text className="block text-sm ml-2">退出登录</Text>
                </Button>
              </>
            ) : (
              <>
                <Text className="block text-sm font-semibold text-foreground mb-2">登录以同步数据</Text>
                <Text className="block text-xs text-muted-foreground mb-4">
                  当前为匿名状态，本机数据保留 30 天。登录后现有内容会自动迁移到你的微信账号，长期保存、多端同步。
                </Text>
                <Button className="w-full h-11 rounded-xl" disabled={busy} onClick={handleLogin}>
                  <LogIn size={16} color={BRAND_FOREGROUND} />
                  <Text className="block text-sm ml-2 text-primary-foreground">微信一键登录</Text>
                </Button>
              </>
            )}
          </Card>

          {/* 智能客服：走大模型 ⇒ 属 AI 外发，个人主体不开放（见 constants/app-info.ts） */}
          {AI_PUBLIC_ENTRY && (
            <Card
              className="rounded-2xl border-border p-4 mb-5"
              onClick={() => Taro.navigateTo({ url: '/pages/chat/index' })}
            >
              <View className="flex flex-row items-center gap-3">
                <View
                  className="rounded-xl flex items-center justify-center"
                  style={{ width: '40px', height: '40px', backgroundColor: 'rgba(16, 185, 129, 0.08)' }}
                >
                  <Bot size={20} color={INK} />
                </View>
                <View className="flex-1">
                  <Text className="block text-sm font-semibold text-foreground">智能客服</Text>
                  <Text className="block text-xs text-muted-foreground mt-1">
                    关于小程序的功能和使用问题都可以问我
                  </Text>
                </View>
                <Text className="block text-base text-muted-foreground">›</Text>
              </View>
            </Card>
          )}

          {/* 数据概览 */}
          <View className="flex flex-row gap-3 mb-5">
            <MiniStat icon={<Inbox size={14} color="#5C5750" />} label="收件箱" value={overview?.total ?? 0} />
            <MiniStat icon={<BookOpen size={14} color="#5C5750" />} label="复习本" value={overview?.review_total ?? 0} />
            <MiniStat icon={<Plus size={14} color="#5C5750" />} label="本周新增" value={overview?.week_total ?? 0} />
          </View>

          {/* 存储配额（策略 6）：拿不到用量时整块不展示 */}
          {usage && (
            <Card className="rounded-2xl border-border p-4 mb-5">
              <View className="flex flex-row items-center gap-2 mb-2">
                <HardDrive size={16} color={INK} />
                <Text className="block text-sm font-semibold text-foreground">存储空间</Text>
                <View className="flex-1" />
                <Text className="block text-xs text-muted-foreground">
                  {formatBytes(usage.used_bytes)} / {formatBytes(usage.quota_bytes)}
                  {' · '}
                  {usage.used_count}/{usage.quota_count} 张
                </Text>
              </View>
              <View className="w-full rounded-full bg-muted overflow-hidden" style={{ height: '6px' }}>
                <View
                  style={{
                    width: `${Math.max(2, Math.min(100, usage.pct))}%`,
                    height: '6px',
                    background: usage.pct >= 90 ? '#C25B4E' : usage.pct >= 80 ? '#E08A3C' : '#6B8E6B',
                  }}
                />
              </View>
              {usage.pct >= 80 && (
                <Text className="block text-xs mt-2 text-muted-foreground">
                  空间即将用满，可在「最近题目」删除不再需要的图片来释放空间。
                </Text>
              )}
            </Card>
          )}

          {/* AI 与在线检索（R-合规-02）：默认关 = 仅本地，任何内容不出机器。
              ⚠️ 个人主体下整块收起（见 constants/app-info.ts）：留着开关等于让审核员
              看到「用户可自行打开 AI 服务」，会被要求补「深度合成-AI问答」类目。 */}
          {AI_PUBLIC_ENTRY ? (
            <Card className="rounded-2xl border-border p-4 mb-5">
              <View className="flex flex-row items-center justify-between">
                <View className="flex flex-row items-center gap-2">
                  <Bot size={16} color="#9A948A" />
                  <Text className="block text-sm font-semibold text-foreground">AI 与在线检索</Text>
                </View>
                <Switch checked={aiEnabled} disabled={busy} onCheckedChange={handleToggleAi} />
              </View>
              <Text className="block mt-2 text-xs text-muted-foreground">
                {aiEnabled
                  ? '已开启：搜答案与智能客服会调用第三方 AI 服务（在线搜题 / 知识库检索 / 大模型解题）。题目内容会离开本机。'
                  : '未开启（仅本地）：识别与题库匹配都在本机完成，题目内容不会发送给任何第三方。开启后才能使用搜答案与智能客服。'}
              </Text>
            </Card>
          ) : (
            <Card className="rounded-2xl border-border p-4 mb-5">
              <View className="flex flex-row items-center gap-2">
                <Bot size={16} color="#9A948A" />
                <Text className="block text-sm font-semibold text-foreground">数据在哪处理</Text>
              </View>
              <Text className="block mt-2 text-xs text-muted-foreground">
                识别、切题、复习排程都在本服务上完成，题目内容不发送给任何第三方。
              </Text>
            </Card>
          )}

          {/* 隐私与账号（R-合规-03）：政策可查、数据可删、账号可注销 */}
          <Card className="rounded-2xl border-border p-4 mb-5">
            <View className="flex flex-row items-center gap-2 mb-2">
              <Pencil size={16} color="#9A948A" />
              <Text className="block text-sm font-semibold text-foreground">隐私与账号</Text>
            </View>
            <Text className="block text-xs text-muted-foreground">
              我们仅使用微信登录标识（openid）区分账号，不获取手机号、通讯录、位置等信息。学习数据属于未成年人，
              我们只收集错题与复习所必需的内容。
            </Text>
            <View className="mt-3 flex flex-row gap-3">
              <View
                className="flex h-9 flex-1 items-center justify-center rounded-xl border border-border"
                onClick={openPolicy}
              >
                <Text className="text-[13px] text-foreground">隐私政策</Text>
              </View>
              <View
                className="flex h-9 flex-1 items-center justify-center rounded-xl border border-border"
                onClick={openAgreement}
              >
                <Text className="text-[13px] text-foreground">用户协议</Text>
              </View>
            </View>
            <View className="mt-3 flex flex-row">
              <View
                className="flex h-9 flex-1 items-center justify-center rounded-xl border border-[#E8C4C0]"
                onClick={handlePurge}
              >
                <Text className="text-[13px] text-[#B3261E]">注销账号</Text>
              </View>
            </View>
          </Card>

          {/* 备案信息（2026-10-29 通过）：微信客户端会在小程序「更多资料」页自动展示备案号，
              这里再放一份，便于审核比对与用户核查。个人主体不公示姓名，只公示备案号。 */}
          <View className="mb-6 mt-1 flex flex-col items-center">
            <Text className="block text-[12px] text-muted-foreground">{APP_NAME}</Text>
            <Text className="mt-1 block text-[12px] text-muted-foreground">{ICP_FILING_NO}</Text>
          </View>

          {!logged && (
            <EmptyCard
              title="你想长期保存这些题目吗？"
              hint="登录后匿名数据自动迁移，30 天内也不会被清理"
              actionLabel="立即登录"
              onAction={handleLogin}
            />
          )}
        </View>
      </ScrollView>
    </View>
  )
}

function MiniStat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: number }) {
  return (
    <Card className="flex-1 rounded-2xl border-border p-3">
      <View className="flex flex-row items-center gap-1 mb-1">
        {icon}
        <Text className="block text-xs text-muted-foreground">{label}</Text>
      </View>
      <Text className="block text-xl font-bold text-foreground">{value}</Text>
    </Card>
  )
}
