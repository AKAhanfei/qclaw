/**
 * /api/knowledge - 内置知识库 RAG 检索
 * 移植自 NexusAI/claw，集成到 QClaw
 * 11个内置知识库：React/Vue/TypeScript/Node.js/Spring Boot/Spring AI/LangChain/Next.js/Docker/微信小程序/腾讯云开发
 */

const express = require('express')
const router  = express.Router()

// ─── 内置知识库内容（11个）────────────────────────────────────────────────────
const KB_CONTEXTS = {
  'react': `# React 知识库
React 是 Meta 开发的用于构建用户界面的 JavaScript 库。
核心概念：组件（函数组件/类组件）、Props、State、虚拟 DOM、Fiber 调度器、Concurrent Mode。
Hooks：useState、useEffect、useCallback、useMemo、useRef、useContext、useReducer、useId、useSyncExternalStore。
React 18 新特性：并发渲染（createRoot）、useTransition、useDeferredValue、Suspense 改进、Server Components、自动批处理。
React 19：use Hook、Server Actions、改进的 Suspense、资源预加载 API、静态网站生成优化。
性能优化：React.memo、懒加载（React.lazy + Suspense）、代码分割、虚拟列表（react-virtual/react-window）。
状态管理：Context API、Redux Toolkit、Zustand、Jotai、Recoil。
测试：React Testing Library、Jest、Vitest、@testing-library/user-event。`,

  'vue': `# Vue 3 知识库
Vue 3 核心：Composition API（setup()、ref()、reactive()、computed()、watch()、watchEffect()）。
<script setup> 语法糖：defineProps、defineEmits、defineExpose、withDefaults、defineModel（Vue3.4+）。
模板语法：v-if、v-for、v-model、v-bind、v-on、插槽（slot）、动态组件、Teleport、Suspense。
生命周期：onMounted、onUnmounted、onBeforeMount、onUpdated、onBeforeUpdate、onActivated、onDeactivated。
Pinia 状态管理：defineStore、storeToRefs、$patch、$reset、持久化插件。
Vue Router 4：useRoute、useRouter、动态路由、路由守卫、懒加载、命名视图。
性能：v-memo、shallowRef、markRaw、triggerRef、defineAsyncComponent。
Vue 3.4+：defineModel 双向绑定语法糖、v-bind 同名简写、改进的 SSR 水合。`,

  'typescript': `# TypeScript 知识库
TypeScript 是 JavaScript 的超集，添加静态类型检查，编译为 JS。
基础类型：string、number、boolean、null、undefined、symbol、bigint、any、unknown、never、void、object。
类型构造：interface（可扩展）、type（联合/交叉/映射）、联合类型(|)、交叉类型(&)、元组、枚举、字面量类型。
泛型：泛型函数、泛型接口、泛型约束(extends)、条件类型(T extends U ? X : Y)、infer 关键字、分布式条件类型。
工具类型：Partial、Required、Readonly、Pick、Omit、Exclude、Extract、Record、ReturnType、Parameters、InstanceType、NonNullable、Awaited、NoInfer（TS5.4+）。
装饰器（TS5+）：标准装饰器规范，类/方法/属性/参数装饰器。
TS 5.x 新特性：const类型参数、装饰器元数据、satisfies 操作符、using 声明（Disposable）、Import Attributes。
配置：tsconfig.json、strict 模式（strictNullChecks/noImplicitAny）、路径别名（paths）、isolatedModules。`,

  'nodejs': `# Node.js 知识库
Node.js 是基于 V8 引擎的 JavaScript 运行时，单线程事件循环架构，适合 I/O 密集型应用。
核心模块：fs（文件系统）、path、http/https、stream、buffer、crypto、child_process（exec/spawn/fork）、worker_threads、events、util、os、net、dns、zlib。
事件循环六阶段：timers → pending callbacks → idle/prepare → poll → check（setImmediate）→ close callbacks。
流(Stream)：Readable、Writable、Duplex、Transform，pipe 管道、backpressure 背压，pipeline()（推荐）。
模块系统：CommonJS(require/module.exports) vs ESM(import/export)，package.json "type":"module"，动态import()。
性能：cluster 多进程（fork()）、worker_threads 多线程（SharedArrayBuffer）、stream pipeline、Buffer 零拷贝。
包管理：npm/yarn/pnpm，package.json scripts，monorepo（npm workspaces/turborepo）。
框架：Express（最流行）、Fastify（最快）、Koa（洋葱中间件）、NestJS（企业级/TypeScript）、Hono（边缘计算）。
安全：Helmet、CORS、rate-limit、input validation（zod/joi）、SQL 注入防御。`,

  'spring-boot': `# Spring Boot 知识库
Spring Boot 3.x 基于 Spring Framework 6，要求 Java 17+，原生支持 GraalVM 本地镜像。
核心注解：@SpringBootApplication、@RestController、@Service、@Repository、@Component、@Autowired、@Value、@ConfigurationProperties、@Bean。
Web 层：@GetMapping/@PostMapping/@PutMapping/@DeleteMapping/@PatchMapping、@RequestBody、@PathVariable、@RequestParam、@ResponseBody、@ExceptionHandler。
数据访问：Spring Data JPA（@Entity、JpaRepository、@Query）、MyBatis（@Mapper）、Spring Data Redis（RedisTemplate）、R2DBC（响应式）。
AOP：@Aspect、@Before、@After、@Around、@Pointcut 切点表达式、@EnableAspectJAutoProxy。
安全：Spring Security 6（SecurityFilterChain Bean 方式替代 WebSecurityConfigurerAdapter）、OAuth2 Client/Resource Server、JWT（jjwt/nimbus）。
Actuator：/actuator/health、/actuator/metrics（Micrometer）、/actuator/info、自定义端点。
测试：@SpringBootTest（集成测试）、@WebMvcTest（Controller 层）、MockMvc、@DataJpaTest（JPA 层）、Testcontainers。
虚拟线程（Java 21+）：spring.threads.virtual.enabled=true，无需手动配置线程池。`,

  'spring-ai': `# Spring AI 知识库
Spring AI 是 Spring 生态的 AI 集成框架，统一各 AI 服务接口，简化 LLM 应用开发。
核心接口：ChatClient（流式/非流式）、EmbeddingModel（向量化）、ImageModel（图像生成）、AudioTranscriptionModel（语音转文字）。
ChatClient 用法：ChatClient.builder(chatModel).build()，.prompt().user("...").call().content()，或 .stream().content()。
支持的模型：OpenAI（GPT-4o）、Anthropic（Claude）、Azure OpenAI、Ollama（本地）、Google Vertex AI/Gemini、Mistral、智谱 GLM。
Advisor（切面）：QuestionAnswerAdvisor（RAG）、MessageChatMemoryAdvisor（记忆）、SafeGuardAdvisor（安全过滤）、Re-Reading Advisor。
向量存储：PgVectorStore、RedisVectorStore、ChromaVectorStore、SimpleVectorStore（内存）、Pinecone、Weaviate、Milvus。
提示词：PromptTemplate 变量替换、SystemPromptTemplate、StringTemplate（TextBlocks）。
Function Calling：@Description注解 + @Bean FunctionCallback，AI 自动决策调用时机。
RAG：ETL Pipeline（DocumentReader → Transformer → Writer）、TokenTextSplitter、TikaDocumentReader。
记忆：InMemoryChatMemory（单进程）、CassandraChatMemory（持久化跨会话）。`,

  'langchain': `# LangChain 知识库
LangChain 是构建 LLM 应用的开源框架（Python/JavaScript 双版本），提供标准化抽象。
核心组件：ChatModels（统一模型接口）、Prompts（PromptTemplate/ChatPromptTemplate/MessagesPlaceholder）、Chains（序列化工作流）、Agents（自主决策）、Tools（外部功能）、Memory（对话历史）、VectorStores（向量检索）、DocumentLoaders（文档摄取）。
LCEL（LangChain Expression Language）：pipe 语法 chain = prompt | llm | parser，支持并行/条件/循环，内置流式输出和异步。
链(Chain)：LLMChain → LCEL 替代、SequentialChain、RouterChain、MapReduceDocumentsChain、RetrievalQA。
Agent 类型：ReAct（思考-行动循环）、OpenAI Functions/Tools Agent、Plan-and-Execute Agent（长任务）。AgentExecutor 控制执行循环。
工具(Tools)：SerpAPI/Tavily（搜索）、Wikipedia、Calculator、Python REPL、FileSystem、Shell（谨慎使用）、自定义 @tool 装饰器。
记忆(Memory)：ConversationBufferMemory、ConversationSummaryMemory、ConversationTokenBufferMemory、VectorStoreRetrieverMemory。
向量数据库：Chroma、Pinecone、FAISS、Weaviate、Qdrant、Milvus、PGVector。
LangSmith：可观测性平台，链路追踪、评估集、数据集、在线实验。
LangGraph：有状态多 Agent 工作流框架，支持循环、条件分支、人工介入（Human-in-the-loop）。`,

  'nextjs': `# Next.js 知识库
Next.js 15 基于 React 19，App Router 架构为主流，兼容 Pages Router。
App Router：app/ 目录约定式路由，page.tsx（页面）、layout.tsx（布局）、loading.tsx（加载）、error.tsx（错误边界）、not-found.tsx、route.ts（API）。
Server Components（默认 RSC）无 JS bundle，Client Components（'use client'）保留 React 状态/副作用。
数据获取：fetch 原生扩展（cache/next.revalidate）、generateStaticParams（静态生成）、unstable_cache、动态函数（cookies/headers）。
Server Actions：'use server' 指令，表单 action 属性、直接调用、乐观更新（useOptimistic）。
路由特性：Link、useRouter、usePathname、useSearchParams、动态段([slug])、平行路由(@slot)、拦截路由((.)folder)、路由组(folder)。
Middleware：middleware.ts 在边缘运行，匹配 matcher，可做 Auth 拦截/重定向/A/B 测试。
优化：next/image（自动 WebP/AVIF + 懒加载）、next/font（零 CLS）、next/script（策略加载）、Partial Prerendering（PPR，静态+动态混合）、Turbopack（新一代打包器）。
部署：Vercel（原生支持）、Docker（standalone 输出）、静态导出（output: 'export'）。`,

  'docker': `# Docker 知识库
Docker 是容器化平台，将应用与依赖打包为可移植镜像，实现环境一致性。
基础命令：docker build -t name:tag .、docker run -d -p 宿主:容器 --name NAME IMAGE、docker ps [-a]、docker logs [-f] CONTAINER、docker exec -it CONTAINER bash、docker stop/start/rm CONTAINER、docker rmi IMAGE。
Dockerfile 指令：FROM（基础镜像）、RUN（构建期执行命令）、COPY/ADD（复制文件）、WORKDIR（工作目录）、ENV（环境变量）、EXPOSE（声明端口）、CMD/ENTRYPOINT（启动命令）、ARG（构建参数）、VOLUME（数据卷）、HEALTHCHECK、LABEL、USER。
多阶段构建：多个 FROM 指令，AS builder → AS runtime，最终镜像只含运行时，Go/Java 应用尤其有效（减小80%+）。
Docker Compose：services/networks/volumes 定义，depends_on（+ condition: service_healthy）、healthcheck、environment、ports、build context、profiles。
网络：bridge（默认容器间通信）、host（共享宿主网络）、none（隔离）、overlay（Swarm/Kubernetes）。自定义 bridge network 实现服务名 DNS 解析。
存储：bind mount（-v 绝对路径:容器路径）、named volume（-v 卷名:容器路径，Docker 管理）、tmpfs（内存临时存储）。
镜像优化技巧：.dockerignore 排除无用文件、利用层缓存（COPY 依赖文件先于源码）、alpine 基础镜像、合并 RUN 命令减少层数、非 root 用户运行（USER node）。
Registry：Docker Hub（公共）、GHCR（GitHub）、ACR/ECR/GCR（云厂商）、Harbor（私有自托管）。`,

  'wx-mini': `# 微信小程序知识库
微信小程序是微信平台的轻量级应用，无需安装，即用即走，基于 JS/WXML/WXSS/JSON 开发。
目录结构：app.js（全局逻辑+生命周期）、app.json（全局配置：pages/tabBar/window）、app.wxss（全局样式）、pages/（各页面目录）。
页面文件四件套：.wxml（模板/HTML）、.wxss（样式/CSS子集）、.js（逻辑/Page()）、.json（页面级配置）。
数据绑定与渲染：{{变量}}、wx:if/wx:elif/wx:else、wx:for（+wx:key）、wx:key="*this"、block 虚拟节点、hidden（保留DOM）。
事件系统：bindtap（不阻止冒泡）、catchtap（阻止冒泡）、bind:input/change、data-xxx 传参（event.currentTarget.dataset）、mark 事件标记。
常用 API：wx.request（网络）、wx.navigateTo/redirectTo/switchTab/navigateBack（路由）、wx.showToast/Modal/Loading（UI反馈）、wx.getStorage/setStorage（本地存储）、wx.login（获取 code→换 openid）、wx.getUserProfile（获取头像昵称）、wx.chooseMedia（选图/视频）、wx.uploadFile（上传）。
组件：view、text（行内文本）、image（懒加载+aspectFill）、scroll-view（滚动容器）、swiper（轮播）、input（表单输入）、button（open-type）、form、picker、map（腾讯地图）、canvas（2D/WebGL）、web-view（内嵌H5）。
自定义组件：Component() 构造器，properties/data/methods，slot 插槽，externalClasses，selectComponent。
云开发（CloudBase）：wx.cloud.init、callFunction（云函数）、database()（MongoDB增删改查）、uploadFile/downloadFile、getTempFileURL。
性能优化：setData 最小化更新、避免频繁 setData、长列表虚拟化（recycle-view）、图片懒加载、分包加载（subpackages）。
Taro / uni-app：跨端框架，一套代码发布微信/支付宝/H5/APP等多端。`,

  'tcb': `# 腾讯云开发（CloudBase）知识库
腾讯云开发（CloudBase/TCB）是全栈 Serverless 一体化云服务，无需管理服务器。
核心服务五大件：云函数（Functions/无服务器计算）、云数据库（MongoDB/文档数据库）、云存储（COS对象存储）、云托管（容器化应用）、静态网站托管。
SDK：@cloudbase/node-sdk（云函数/服务端）、@cloudbase/js-sdk（Web 浏览器）、wx-server-sdk（微信小程序云函数内专用）。
云数据库操作：const db = cloud.database()，db.collection('name').add({data})/.get()/.where(条件).get()/.doc(id).update({data})/.remove()。支持实时监听 watch({onChange,onError})。
查询操作符：db.command.eq/gt/gte/lt/lte/neq（比较）、in/nin（集合）、and/or/not（逻辑）、geoNear（地理位置）、aggregate（聚合管道）。
云函数：exports.main = async (event, context) => { return result }，event 为调用入参，context 含云函数信息。callFunction({name:'fn',data:{k:v}}) 调用。
云存储：uploadFile({cloudPath, fileContent})、downloadFile({fileID})、getTempFileURL({fileList})（有效期10min-7天）、deleteFile。
HTTP 访问服务：开启后云函数可通过 HTTP URL 直接访问，无需鉴权，适合 Webhook/第三方回调。
TCB-Router：云函数内轻量路由，app.router('user', async(ctx,next) => {})，一个函数支持多路由，避免函数爆炸。
环境变量自动注入：process.env.TENCENTCLOUD_SECRETID/SECRETKEY/SESSIONTOKEN（临时密钥）、TENCENTCLOUD_REGION、SCF_FUNCTIONNAME。
计费模式：按量计费（调用次数+流量+存储），包年包月套餐（适合稳定业务）。免费额度：每月调用10万次云函数、1GB存储、1GB CDN流量。`,
}

// ─── 导出可直接调用的搜索函数（供 chat.js 使用）────────────────────────────
function searchKnowledge(query, kbIds = [], customKBs = []) {
  if (!query?.trim()) return []

  const allContexts = { ...KB_CONTEXTS }
  for (const kb of (customKBs || [])) {
    if (kb.id && kb.content) allContexts[kb.id] = kb.content
  }

  const targetIds = kbIds.length > 0 ? kbIds : Object.keys(allContexts)
  const results   = []
  const words     = query.toLowerCase().split(/\s+/).filter(Boolean)

  for (const id of targetIds) {
    const ctx = allContexts[id]
    if (!ctx) continue
    const ctxLower   = ctx.toLowerCase()
    const matchCount = words.filter(w => ctxLower.includes(w)).length
    const score      = matchCount / words.length
    if (score > 0) {
      const lines        = ctx.split('\n').filter(Boolean)
      const matchedLines = lines.filter(l => words.some(w => l.toLowerCase().includes(w)))
      const snippet      = matchedLines.slice(0, 3).join('\n') || ctx.slice(0, 200)
      results.push({
        kbId:        id,
        content:     snippet,
        fullContent: ctx,
        relevance:   score,
        source:      `知识库: ${id}`,
      })
    }
  }

  return results.sort((a, b) => b.relevance - a.relevance).slice(0, 5)
}

// ── POST /api/knowledge/search ──────────────────────────────────────────────
router.post('/search', (req, res) => {
  const { query = '', kbIds = [], customKBs = [] } = req.body
  const results = searchKnowledge(query, kbIds, customKBs)
  res.json({ results })
})

// ── GET /api/knowledge/list ─────────────────────────────────────────────────
router.get('/list', (req, res) => {
  res.json({
    knowledgeBases: Object.keys(KB_CONTEXTS).map(id => ({
      id,
      available: true,
      title: {
        react:       'React',
        vue:         'Vue 3',
        typescript:  'TypeScript',
        nodejs:      'Node.js',
        'spring-boot': 'Spring Boot',
        'spring-ai': 'Spring AI',
        langchain:   'LangChain',
        nextjs:      'Next.js',
        docker:      'Docker',
        'wx-mini':   '微信小程序',
        tcb:         '腾讯云开发',
      }[id] || id,
    })),
  })
})

module.exports = router
module.exports.searchKnowledge = searchKnowledge
