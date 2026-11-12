# 校园通 CampusQA —— 生产镜像
# 零第三方依赖，所以不需要 npm install，镜像很小

FROM node:22-alpine

WORKDIR /app

# 只拷贝运行所需内容（tools/ docs/ deliverables/ 不进入镜像）
COPY app ./app
COPY package.json ./

# 运行时可写目录（会话与反馈日志；容器重启会清空，不影响核心功能）
RUN mkdir -p app/data/runtime

# 容器内以非 root 运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV PORT=8080
ENV QA_HOST=0.0.0.0

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/server.mjs"]
