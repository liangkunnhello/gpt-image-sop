/**
 * 拖拽提示。
 *
 * 以前是全屏半透明遮罩 + 大图标，拖图进来整个任务卡区域都被糊住，
 * 下面的卡片状态完全看不见。现在只留顶部一条小药丸提示：
 * 不铺满、不拦截点击，任务卡照常可见。
 */
export default function DragUploadOverlay({
  visible,
  atImageLimit,
  maxImages,
}: {
  visible: boolean
  atImageLimit: boolean
  maxImages: number
}) {
  if (!visible) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[72px] z-[100] flex justify-center px-4">
      <div
        className={`flex max-w-full items-center gap-2 rounded-full px-4 py-2 text-xs font-medium shadow-[0_8px_24px_rgb(0,0,0,0.18)] backdrop-blur-md ${
          atImageLimit ? 'bg-red-500/90 text-white' : 'bg-blue-500/90 text-white'
        }`}
      >
        {atImageLimit ? (
          <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        ) : (
          <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        )}
        <span className="whitespace-nowrap">
          {atImageLimit ? `已达上限 ${maxImages} 张，请先移除部分参考图` : '释放以上传图片'}
        </span>
      </div>
    </div>
  )
}
