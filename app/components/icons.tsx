import arrowRightSvg from 'heroicons/24/outline/arrow-right.svg?raw'
import bookOpenSvg from 'heroicons/24/outline/book-open.svg?raw'
import ellipsisHorizontalSvg from 'heroicons/24/outline/ellipsis-horizontal.svg?raw'
import cherryStudioSvg from '@lobehub/icons-static-svg/icons/cherrystudio-color.svg?raw'
import claudeCodeSvg from '@lobehub/icons-static-svg/icons/claudecode-color.svg?raw'

export type IconProps = {
  class?: string
}

/** 统一图标出口：基础 UI 用 heroicons，品牌用 @lobehub/icons-static-svg，均 ?raw 直引包内 SVG。 */
export const Icon = ({ src, class: cls = 'h-5 w-5' }: IconProps & { src: string }) => (
  <span
    class={`inline-flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full ${cls}`}
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: src }}
  />
)

export const ArrowRightIcon = ({ class: cls = 'h-[18px] w-[18px]' }: IconProps = {}) => (
  <Icon src={arrowRightSvg} class={cls} />
)

export const BookOpenIcon = ({ class: cls = 'h-[18px] w-[18px]' }: IconProps = {}) => (
  <Icon src={bookOpenSvg} class={cls} />
)

export const EllipsisHorizontalIcon = ({ class: cls = 'h-6 w-6' }: IconProps = {}) => (
  <Icon src={ellipsisHorizontalSvg} class={cls} />
)

export const CherryStudioIcon = ({ class: cls = 'h-7 w-7' }: IconProps = {}) => (
  <Icon src={cherryStudioSvg} class={cls} />
)

export const ClaudeCodeIcon = ({ class: cls = 'h-7 w-7' }: IconProps = {}) => (
  <Icon src={claudeCodeSvg} class={cls} />
)
