import { useEffect, useState } from 'react'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../../lib/imageCache'

/**
 * 输入区 52×52 的小缩略图。
 *
 * 这里原来直接用 `img.dataUrl`（整张原图的 base64），拖进二三十张大图时光是
 * 给每个 `<img>` 塞几十 MB 的字符串就够卡一阵了。改成优先用缩略图缓存：
 * 有缩略图就用缩略图（几十 KB 的 webp），还没生成时先显示原图兜底，
 * 生成完成后自动切换，用户无感。
 */
export default function InputThumbImage({
  imageId,
  fallbackSrc,
  className,
  alt = '',
}: {
  imageId: string
  fallbackSrc: string
  className?: string
  alt?: string
}) {
  const [thumbSrc, setThumbSrc] = useState('')

  useEffect(() => {
    if (!imageId) {
      setThumbSrc('')
      return
    }
    let cancelled = false
    const apply = (thumbnail: { src: string }) => {
      if (!cancelled) setThumbSrc(thumbnail.src)
    }
    const unsubscribe = subscribeImageThumbnail(imageId, apply)
    ensureImageThumbnailCached(imageId)
      .then((thumbnail) => {
        if (thumbnail) apply(thumbnail)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [imageId])

  const src = thumbSrc || fallbackSrc
  if (!src) return null
  return <img src={src} className={className} alt={alt} />
}
