import * as React from "react"
import { Textarea as TaroTextarea, View } from "@tarojs/components"

import { cn } from "@/lib/utils"

export interface TextareaProps
  extends React.ComponentPropsWithoutRef<typeof TaroTextarea> {
  className?: string
  autoFocus?: boolean
}

const Textarea = React.forwardRef<
  React.ElementRef<typeof TaroTextarea>,
  TextareaProps
>(({ className, autoFocus, focus, onFocus, onBlur, ...props }, ref) => {
  const [isFocused, setIsFocused] = React.useState(false)
  const disabled = !!(props as any).disabled

  React.useEffect(() => {
    if (autoFocus || focus) setIsFocused(true)
  }, [autoFocus, focus])
  return (
    <View
      className={cn(
        "flex h-20 w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background focus-within:border-ring focus-within:ring-4 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
        isFocused && "border-ring ring-4 ring-ring ring-offset-2 ring-offset-background",
        className
      )}
      onTouchStart={() => {
        if (disabled) return
        setIsFocused(true)
      }}
    >
      <TaroTextarea
        // ⚠️ 默认不限长（思傅 2026-10-26）：微信 textarea 的 maxlength 默认值是 **140**，
        //    不显式给 -1 就会静默截断——答案/解析/题干这类长文本全被砍在第 140 字。
        //    放在 {...props} 之前：调用方显式传 maxlength 时仍以调用方为准。
        maxlength={-1}
        className="flex-1 w-full h-full bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm selection:bg-selection selection:text-selection-foreground"
        placeholderClass="text-muted-foreground"
        ref={ref}
        focus={autoFocus || focus}
        onFocus={(e) => {
          setIsFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setIsFocused(false)
          onBlur?.(e)
        }}
        {...props}
      />
    </View>
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
