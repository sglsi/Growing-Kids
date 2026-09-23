import { View, Text, ScrollView, Image as TaroImage, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import ImageEditor from '@/components/image-editor'
import MaterialPicker from '@/components/material-picker'
import {
  fetchSubjects, recognizePaper, recognizeSeparate, recognizeDocument, createQuestion,
  recognizePaperByUrl, recognizeDocumentByUrl, uploadImage, saveQuestionAsImage,
  type Subject, type RecognizeResult, type Material
} from '@/services/api'

type Mode = 'paper' | 'split' | 'doc'

interface Draft extends RecognizeResult {
  subject_id: string
}

export default function RecognizePage() {
  const [mode, setMode] = useState<Mode>(() => (Taro.getStorageSync('recog_mode') || 'paper') as Mode)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [defaultSubject, setDefaultSubject] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(false)
  const [paperImage, setPaperImage] = useState('')
  const [questionImage, setQuestionImage] = useState('')
  const [answerImage, setAnswerImage] = useState('')
  const [docFile, setDocFile] = useState('')
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // 图片编辑器：{ slot, src }
  const [editor, setEditor] = useState<{ slot: 'paper' | 'question' | 'answer'; src: string } | null>(null)

  // 素材库选择
  const [picker, setPicker] = useState<'image' | 'document' | null>(null)

  useEffect(() => {
    Taro.removeStorageSync('recog_mode')
  }, [])

  const ensureSubjects = async () => {
    if (subjects.length === 0) {
      const list = await fetchSubjects()
      setSubjects(list)
      setDefaultSubject(list[1]?.id || list[0]?.id || '')
      return list
    }
    return subjects
  }

  const chooseImage = async (slot: 'paper' | 'question' | 'answer') => {
    try {
      const res = await Taro.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album']
      })
      // 先进入裁剪/旋转编辑器
      setEditor({ slot, src: res.tempFiles[0].tempFilePath })
    } catch {
      // 用户取消
    }
  }

  // 编辑确认：把处理后的图片写回对应槽位
  const handleEditorConfirm = (path: string) => {
    const slot = editor?.slot
    setEditor(null)
    if (!slot) return
    if (slot === 'paper') setPaperImage(path)
    else if (slot === 'question') setQuestionImage(path)
    else setAnswerImage(path)
  }

  // 整卷识别
  const handleRecognizePaper = async () => {
    if (!paperImage) {
      Taro.showToast({ title: '请先拍照或选择图片', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizePaper(paperImage, sid)
      setDrafts(result.map(r => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  // 分传关联
  const handleLink = async () => {
    if (!questionImage || !answerImage) {
      Taro.showToast({ title: '题目图和答案图都需上传', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const res = await recognizeSeparate(questionImage, answerImage)
      setDrafts(res.matched.map(r => ({ ...r, subject_id: sid })))
      setUnmatched(res.unmatched_questions)
      Taro.showToast({ title: `已关联 ${res.matched.length} 题`, icon: 'none' })
    } catch (e) {
      console.error('关联失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '关联失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  // 从素材库选择图片素材后直接按 URL 识别（整卷）
  const handleSelectImageMaterial = async (m: Material) => {
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setPaperImage(m.url)
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizePaperByUrl(m.url, sid)
      setDrafts(result.map(r => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('素材识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  // 从素材库选择文档素材后直接按 URL 识别
  const handleSelectDocMaterial = async (m: Material) => {
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setDocFile(m.name)
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizeDocumentByUrl(m.url, sid)
      setDrafts(result.map(r => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('素材文档识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  const pickDoc = async (cb: (path: string, name: string) => void) => {
    try {
      const res = await Taro.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['pdf', 'doc', 'docx', 'txt'],
      })
      const f = res.tempFiles[0]
      cb(f.path, f.name || '')
    } catch {
      Taro.showToast({ title: '请在微信小程序中从聊天/文件中选择文档', icon: 'none' })
    }
  }

  // 文档导入识别（PDF / Word / TXT 等）
  const handleRecognizeDoc = async () => {
    if (!docFile) {
      Taro.showToast({ title: '请先选择文档文件', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizeDocument(docFile, sid)
      setDrafts(result.map(r => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('文档识别失败', e)
      Taro.showToast({
        title: e instanceof Error ? e.message : '文档识别失败，请确认内容为文字',
        icon: 'none',
      })
    } finally {
      setLoading(false)
    }
  }

  const updateDraft = (idx: number, patch: Partial<Draft>) => {
    setDrafts(prev => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  const removeDraft = (idx: number) => {
    setDrafts(prev => prev.filter((_, i) => i !== idx))
  }

  const handleSave = async () => {
    if (!drafts.length) return
    setSaving(true)
    try {
      await Promise.all(drafts.map(d => createQuestion({
        subject_id: d.subject_id,
        question_content: d.question_content,
        answer_content: d.answer_content,
        solution: d.solution,
        wrong_answer: d.wrong_answer,
        source: d.source,
        status: d.has_answer || d.answer_content ? 'answered' : 'pending'
      })))
      Taro.showToast({ title: '已保存到错题本', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 800)
    } catch (e) {
      console.error('保存失败', e)
    } finally {
      setSaving(false)
    }
  }

  // 直接以图片形式保存为错题（不依赖 OCR），避免识别率低丢失内容
  const handleSaveImageDirect = async () => {
    if (!paperImage) {
      Taro.showToast({ title: '请先拍照或选择图片', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setSaving(true)
    try {
      const { key, url } = await uploadImage(paperImage)
      await saveQuestionAsImage(sid, key, url)
      Taro.showToast({ title: '已以图片形式保存', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 800)
    } catch (e) {
      console.error('图片直存失败', e)
      Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const subjectIndex = (id: string) => Math.max(0, subjects.findIndex(s => s.id === id))
  const subjectName = (id: string) => subjects.find(s => s.id === id)?.name || '选择学科'

  return (
    <ScrollView scrollY className="h-full bg-background">
      <View className="px-4 pt-4 pb-40">
        {/* 模式切换 */}
        <View className="flex flex-row bg-muted rounded-xl p-1 mb-4">
          <ModeTab active={mode === 'paper'} onClick={() => setMode('paper')} label="拍照识别" />
          <ModeTab active={mode === 'split'} onClick={() => setMode('split')} label="题目答案分传" />
          <ModeTab active={mode === 'doc'} onClick={() => setMode('doc')} label="导入文档" />
        </View>

        {/* 学科选择 */}
        <View className="flex flex-row items-center justify-between mb-4">
          <Text className="block text-sm text-muted-foreground">默认归类学科</Text>
          <Picker
            mode="selector"
            range={subjects}
            rangeKey="name"
            onChange={(e) => setDefaultSubject(subjects[Number(e.detail.value)]?.id || '')}
          >
            <View className="bg-muted rounded-lg px-4 py-2">
              <Text className="block text-sm text-primary">{subjects.find(s => s.id === defaultSubject)?.name || '点击选择'}</Text>
            </View>
          </Picker>
        </View>

        {mode === 'paper' ? (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Text className="block text-xs text-muted-foreground mb-3">拍摄作业、试卷（含老师批改痕迹效果最佳）</Text>
            {paperImage ? (
              <TaroImage src={paperImage} mode="widthFix" className="w-full rounded-xl mb-3" onClick={() => chooseImage('paper')} />
            ) : (
              <View className="w-full h-40 border-2 border-dashed border-border rounded-xl flex items-center justify-center mb-3" onClick={() => chooseImage('paper')}>
                <Text className="block text-sm text-muted-foreground">点击拍照 / 从相册选择</Text>
              </View>
            )}
            <Button className="w-full h-11 rounded-xl" disabled={loading} onClick={handleRecognizePaper}>
              <Text className="block text-sm">{loading ? '识别中…' : '开始识别'}</Text>
            </Button>
            <View className="flex flex-row items-center justify-center gap-6 mt-3">
              <View onClick={() => handleSaveImageDirect()}>
                <Text className="block text-xs text-primary">以图片形式直接保存</Text>
              </View>
              <View onClick={() => setPicker('image')}>
                <Text className="block text-xs text-muted-foreground">从素材库选择图片</Text>
              </View>
            </View>
          </Card>
        ) : mode === 'split' ? (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Text className="block text-xs text-muted-foreground mb-3">分别上传题目图和答案图，系统自动识别并关联</Text>
            <View className="flex flex-row gap-3 mb-3">
              <SplitUploader title="题目" image={questionImage} onPick={() => chooseImage('question')} />
              <SplitUploader title="答案" image={answerImage} onPick={() => chooseImage('answer')} />
            </View>
            <Button className="w-full h-11 rounded-xl" disabled={loading} onClick={handleLink}>
              <Text className="block text-sm">{loading ? '识别中…' : '识别并关联'}</Text>
            </Button>
          </Card>
        ) : (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Text className="block text-xs text-muted-foreground mb-3">支持 PDF / Word(.docx) / TXT，从手机或电脑选择文档导入并自动识别题目</Text>
            {docFile ? (
              <View className="w-full bg-muted bg-opacity-60 rounded-xl px-4 py-4 mb-3" onClick={() => pickDoc(setDocFile)}>
                <Text className="block text-sm text-primary break-all">{docFile}</Text>
              </View>
            ) : (
              <View className="w-full h-28 border-2 border-dashed border-border rounded-xl flex items-center justify-center mb-3" onClick={() => pickDoc(setDocFile)}>
                <Text className="block text-sm text-muted-foreground">点击选择文档文件（PDF/Word/TXT）</Text>
              </View>
            )}
            <Button className="w-full h-11 rounded-xl" disabled={loading} onClick={handleRecognizeDoc}>
              <Text className="block text-sm">{loading ? '识别中…' : '导入并识别'}</Text>
            </Button>
            <View className="flex items-center justify-center mt-3" onClick={() => setPicker('document')}>
              <Text className="block text-xs text-primary">从素材库选择文档</Text>
            </View>
          </Card>
        )}

        {loading && (
          <View className="space-y-3">
            <Skeleton className="h-32 w-full rounded-2xl" />
            <Skeleton className="h-32 w-full rounded-2xl" />
          </View>
        )}

        {unmatched.length > 0 && (
          <Card className="rounded-2xl border-border p-3 mb-3 bg-amber-50 border-amber-200">
            <Text className="block text-xs text-amber-700">有 {unmatched.length} 道题目未匹配到答案，保存后可联网搜题</Text>
          </Card>
        )}

        {/* 识别结果草稿（可逐条编辑） */}
        {drafts.length > 0 && (
          <>
            <View className="mb-3">
              <Text className="block text-sm font-semibold text-foreground">识别结果（{drafts.length} 题，可修改）</Text>
            </View>
            {drafts.map((d, idx) => (
              <Card key={idx} className="rounded-2xl border-border p-4 mb-3">
                <View className="flex flex-row items-center justify-between mb-3">
                  <Text className="block text-xs text-muted-foreground">第 {idx + 1} 题</Text>
                  <View className="flex flex-row gap-3">
                    <Picker
                      mode="selector"
                      range={subjects}
                      rangeKey="name"
                      value={subjectIndex(d.subject_id)}
                      onChange={(e) => updateDraft(idx, { subject_id: subjects[Number(e.detail.value)]?.id || d.subject_id })}
                    >
                      <Text className="block text-xs text-primary">{subjectName(d.subject_id)}</Text>
                    </Picker>
                    <Text className="block text-xs text-muted-foreground" onClick={() => removeDraft(idx)}>删除</Text>
                  </View>
                </View>

                <View className="bg-muted bg-opacity-60 rounded-xl p-3 mb-2">
                  <Textarea
                    className="min-h-24 border-0 ring-0 focus-within:ring-0 rounded-lg"
                    value={d.question_content}
                    placeholder="题目内容（可手动修改）"
                    maxlength={2000}
                    onInput={(e) => updateDraft(idx, { question_content: e.detail.value })}
                  />
                </View>

                {d.wrong_answer ? (
                  <Text className="block text-xs text-muted-foreground mb-2 line-through">原错答：{d.wrong_answer}</Text>
                ) : null}

                <View className="rounded-xl p-3 mb-1 border" style={{ borderColor: 'rgba(190,62,45,0.25)', backgroundColor: 'rgba(190,62,45,0.04)' }}>
                  <Textarea
                    className="min-h-20 border-0 ring-0 focus-within:ring-0 rounded-lg"
                    value={d.answer_content}
                    placeholder="正确答案（可手动修改，无则留空后联网搜题）"
                    maxlength={2000}
                    onInput={(e) => updateDraft(idx, { answer_content: e.detail.value, has_answer: !!e.detail.value })}
                  />
                </View>
              </Card>
            ))}
          </>
        )}
      </View>

      {/* 底部保存栏 */}
      {drafts.length > 0 && (
        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <Text className="block text-xs text-muted-foreground shrink-0">共 {drafts.length} 题</Text>
          <Button className="flex-1 h-11 rounded-xl" disabled={saving} onClick={handleSave}>
            <Text className="block text-sm">{saving ? '保存中…' : '保存到错题本'}</Text>
          </Button>
        </View>
      )}

      {/* 拍照/相册后的裁剪与旋转编辑 */}
      <ImageEditor
        visible={!!editor}
        src={editor?.src || ''}
        onCancel={() => setEditor(null)}
        onConfirm={handleEditorConfirm}
      />

      {/* 从素材库选择 */}
      <MaterialPicker
        visible={picker !== null}
        type={picker || 'image'}
        title={picker === 'document' ? '从素材库选择文档' : '从素材库选择图片'}
        onClose={() => setPicker(null)}
        onSelect={(m) => {
          if (m.type === 'document') void handleSelectDocMaterial(m)
          else void handleSelectImageMaterial(m)
        }}
      />
    </ScrollView>
  )
}

function ModeTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <View
      className={`flex-1 flex items-center justify-center h-9 rounded-lg ${active ? 'bg-background shadow-sm' : ''}`}
      onClick={onClick}
    >
      <Text className={`block text-sm ${active ? 'text-primary font-medium' : 'text-muted-foreground'}`}>{label}</Text>
    </View>
  )
}

function SplitUploader({ title, image, onPick }: { title: string; image: string; onPick: () => void }) {
  return (
    <View className="flex-1">
      <Text className="block text-xs text-muted-foreground mb-2">{title}</Text>
      {image ? (
        <TaroImage src={image} mode="aspectFill" className="w-full h-28 rounded-xl" onClick={onPick} />
      ) : (
        <View className="w-full h-28 border-2 border-dashed border-border rounded-xl flex items-center justify-center" onClick={onPick}>
          <Text className="block text-xs text-muted-foreground">上传{title}图</Text>
        </View>
      )}
    </View>
  )
}
