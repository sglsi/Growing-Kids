import { View, Text, Image, ScrollView, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { CircleUser, LogIn, LogOut, Pencil } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyCard } from '@/components/filter-header'
import {
  getAuthState, isLoggedIn, promptLogin, logout, fetchMe, updateProfile,
  type AuthState,
} from '@/services/auth'
import { fetchOverview, type Overview } from '@/services/api'

/**
 * 我的：登录 / 退出 / 资料 / 账号信息
 * 匿名身份也能进本页，只是提示「登录以同步数据」
 */
export default function ProfilePage() {
  const [state, setState] = useState<AuthState | null>(getAuthState())
  const [overview, setOverview] = useState<Overview | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState('')

  const load = async () => {
    setState(getAuthState())
    try {
      const ov = await fetchOverview()
      setOverview(ov)
    } catch {
      /* 概览失败不影响本页 */
    }
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
  })

  const handleLogin = async () => {
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
    <View className="bg-background" style={{ height: '100vh' }}>
      <ScrollView scrollY style={{ height: '100vh' }}>
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
                  <Text className="block text-xs text-primary" onClick={handleEditNickname}>
                    编辑
                  </Text>
                )}
              </View>
              <Text className="block text-xs text-muted-foreground mt-1">
                {logged ? '已登录（数据云端同步）' : '匿名使用中（数据保留 1 天）'}
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
                  <LogOut size={16} color="#BE3E2D" />
                  <Text className="block text-sm ml-2">退出登录</Text>
                </Button>
              </>
            ) : (
              <>
                <Text className="block text-sm font-semibold text-foreground mb-2">登录以同步数据</Text>
                <Text className="block text-xs text-muted-foreground mb-4">
                  当前为匿名状态，数据仅保留 1 天。登录后现有内容会自动迁移到你的微信账号，长期保存、多端同步。
                </Text>
                <Button className="w-full h-11 rounded-xl" disabled={busy} onClick={handleLogin}>
                  <LogIn size={16} color="#fff" />
                  <Text className="block text-sm ml-2 text-primary-foreground">微信一键登录</Text>
                </Button>
              </>
            )}
          </Card>

          {/* 数据概览 */}
          <View className="flex flex-row gap-3 mb-5">
            <MiniStat label="收件箱" value={overview?.total ?? 0} />
            <MiniStat label="复习本" value={overview?.review_total ?? 0} />
            <MiniStat label="本周新增" value={overview?.week_total ?? 0} />
          </View>

          {/* 说明 */}
          {logged ? (
            <Card className="rounded-2xl border-border p-4">
              <View className="flex flex-row items-center gap-2 mb-2">
                <Pencil size={16} color="#9A948A" />
                <Text className="block text-sm font-semibold text-foreground">关于隐私</Text>
              </View>
              <Text className="block text-xs text-muted-foreground">
                我们仅使用微信登录标识（openid）区分账号，不获取你的手机号、通讯录等敏感信息。
              </Text>
            </Card>
          ) : (
            <EmptyCard
              title="你想长期保存这些题目吗？"
              hint="登录后匿名数据自动迁移，1 天后也不会被清理"
              actionLabel="立即登录"
              onAction={handleLogin}
            />
          )}
        </View>
      </ScrollView>
    </View>
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="flex-1 rounded-2xl border-border p-3">
      <Text className="block text-xl font-bold text-foreground">{value}</Text>
      <Text className="block text-xs mt-1 text-muted-foreground">{label}</Text>
    </Card>
  )
}
