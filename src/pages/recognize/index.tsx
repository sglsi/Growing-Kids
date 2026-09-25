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
  recognizeDocumentByUrl, uploadImage, saveQuestionAsImage,
  type Subject, type RecognizeResult, type LibraryDoc, type ImageAction,
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

  // 图片编辑器：{ slot, src, autoAction }
  const [editor, setEditor] = useState<{ slot: 'paper' | 'question' | 'answer'; src: string; autoAction?: ImageAction | null } | null>(null)

  const [picker, setPicker] = useState(false)

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
        sourceType: ['camera', 'album'],
      })
      setEditor({ slot, src: res.tempFiles[0].tempFilePath })
    } catch {
      // 用户取消
    }
  }

  const openEditorWithAction = (slot: 'paper' | 'question' | 'answer', action: ImageAction) => {
    if (slot === 'paper' && paperImage) setEditor({ slot, src: paperImage, autoAction: action })
    else if (slot === 'question' && questionImage) setEditor({ slot, src: questionImage, autoAction: action })
    else if (slot === 'answer' && answerImage) setEditor({ slot, src: answerImage, autoAction: action })
    else Taro.showToast({ title: '请先选择图片', icon: 'none' })
  }

  const handleEditorConfirm = (path: string) => {
    const slot = editor?.slot
    setEditor(null)
    if (!slot) return
    if (slot === 'paper') setPaperImage(path)
    else if (slot === 'question') setQuestionImage(path)
    else setAnswerImage(path)
  }

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
      setDrafts(result.map((r) => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

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
      setDrafts(res.matched.map((r) => ({ ...r, subject_id: sid })))
      setUnmatched(res.unmatched_questions)
      Taro.showToast({ title: `已关联 ${res.matched.length} 题`, icon: 'none' })
    } catch (e) {
      console.error('关联失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '关联失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  // 从资料库选择后按 URL 识别
  const handleSelectDoc = async (d: LibraryDoc) => {
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setDocFile(d.name)
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizeDocumentByUrl(d.url || '', sid)
      setDrafts(result.map((r) => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('资料识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  // 最近题目里的图片 → 按 URL 整卷识别（供未来从收件箱直接识别复用）
  // 目前入口：资料库选文档；图片识别走拍照/相册

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
      setDrafts(result.map((r) => ({ ...r, subject_id: sid })))
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
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  const removeDraft = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleSave = async () => {
    if (!drafts.length) return
    setSaving(true)
    try {
      await Promise.all(drafts.map((d) => createQuestion({
        subject_id: d.subject_id,
        question_content: d.question_content,
        answer_content: d.answer_content,
        solution: d.solution,
        wrong_answer: d.wrong_answer,
        source: d.source,
        status: d.has_answer || d.answer_content ? 'answered' : 'pending',
      })))
      Taro.showToast({ title: '已保存到最近题目', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 800)
    } catch (e) {
      console.error('保存失败', e)
      Taro.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveImageDirect = async () => {
    if (!paperImage) {
      Taro.showToast({ title: '请先拍照或选择图片', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setSaving(true)
    try {
      const up = await uploadImage(paperImage)
      // 后端 /api/upload 已为图片自动建立 timeline(kind=image) 条目，直接用其 id 补学科
      await saveQuestionAsImage(sid, up.key, up.url, up.timeline_id)
      Taro.showToast({ title: '已保存到最近题目', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 800)
    } catch (e) {
      console.error('图片直存失败', e)
      Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const subjectIndex = (id: string) => Math.max(0, subjects.findIndex((s) => s.id === id))
  const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name || '选择学科'

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
              <Text className="block text-sm text-primary">{subjects.find((s) => s.id === defaultSubject)?.name || '点击选择'}</Text>
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
            <View className="flex flex-row items-center justify-between gap-1 mb-3">
              <ImgActionBtn label="编辑裁剪" onClick={() => { if (paperImage) setEditor({ slot: 'paper', src: paperImage }); else chooseImage('paper') }} />
              <ImgActionBtn label="自动调正" onClick={() => openEditorWithAction('paper', 'auto')} />
              <ImgActionBtn label="智能高清" onClick={() => openEditorWithAction('paper', 'enhance')} />
              <ImgActionBtn label="去手写" onClick={() => openEditorWithAction('paper', 'erase')} />
            </View>
            <Button className="w-full h-11 rounded-xl" disabled={loading} onClick={handleRecognizePaper}>
              <Text className="block text-sm">{loading ? '识别中…' : '开始识别'}</Text>
            </Button>
            <View className="flex flex-row items-center justify-center mt-3">
              <View onClick={() => handleSaveImageDirect()}>
                <Text className="block text-xs text-primary">以图片形式直接保存到最近题目</Text>
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
            <Text className="block text-xs text-muted-foreground mb-2">图片处理（分别对题目 / 答案图生效）</Text>
            <View className="flex flex-row items-center justify-between gap-1 mb-3">
              <ImgActionBtn label="自动调正·题" onClick={() => openEditorWithAction('question', 'auto')} />
              <ImgActionBtn label="自动调正·答" onClick={() => openEditorWithAction('answer', 'auto')} />
              <ImgActionBtn label="高清·题" onClick={() => openEditorWithAction('question', 'enhance')} />
              <ImgActionBtn label="高清·答" onClick={() => openEditorWithAction('answer', 'enhance')} />
            </View>
            <View className="flex flex-row items-center justify-between gap-1 mb-3">
              <ImgActionBtn label="去手写·题" onClick={() => openEditorWithAction('question', 'erase')} />
              <ImgActionBtn label="去手写·答" onClick={() => openEditorWithAction('answer', 'erase')} />
              <ImgActionBtn label="编辑·题" onClick={() => { if (questionImage) setEditor({ slot: 'question', src: questionImage }) }} />
              <ImgActionBtn label="编辑·答" onClick={() => { if (answerImage) setEditor({ slot: 'answer', src: answerImage }) }} />
            </View>
            <Button className="w-full h-11 rounded-xl" disabled={loading} onClick={handleLink}>
              <Text className="block text-sm">{loading ? '识别中…' : '识别并关联'}</Text>
            </Button>
          </Card>
        ) : (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Text className="block text-xs text-muted-foreground mb-3">支持 PDF / Word(.docx) / TXT，从手机或电脑选择文档导入并自动识别题目</Text>
            {docFile ? (
              <View className="w-full bg-muted rounded-xl px-4 py-4 mb-3" onClick={() => pickDoc(setDocFile)}>
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
            <View className="flex items-center justify-center mt-3" onClick={() => setPicker(true)}>
              <Text className="block text-xs text-primary">从资料库选择文档</Text>
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

                <View className="bg-muted rounded-xl p-3 mb-2">
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

      {drafts.length > 0 && (
        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <Text className="block text-xs text-muted-foreground shrink-0">共 {drafts.length} 题</Text>
          <Button className="flex-1 h-11 rounded-xl" disabled={saving} onClick={handleSave}>
            <Text className="block text-sm">{saving ? '保存中…' : '保存到最近题目'}</Text>
          </Button>
        </View>
      )}

      <ImageEditor
        visible={!!editor}
        src={editor?.src || ''}
        autoAction={editor?.autoAction || null}
        onCancel={() => setEditor(null)}
        onConfirm={handleEditorConfirm}
      />

      <MaterialPicker
        visible={picker}
        title="从资料库选择文档"
        onClose={() => setPicker(false)}
        onSelect={(d) => void handleSelectDoc(d)}
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

function ImgActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <View className="flex-1 bg-muted rounded-lg py-2 flex items-center justify-center" onClick={onClick}>
      <Text className="block text-xs text-primary text-center">{label}</Text>
    </View>
  )
}
