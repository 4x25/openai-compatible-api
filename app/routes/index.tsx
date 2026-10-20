import { createRoute } from 'honox/factory'
import App from '../islands/App'

export default createRoute((c) => {
  return c.render(
    <div>
      <title>OpenAI 兼容网关</title>
      <App />
    </div>,
  )
})
