// Express 全局命名空间补丁（真实项目由 @types/multer 提供 global.Express.Multer）
declare namespace Express {
  namespace Multer {
    interface File {
      fieldname: string
      originalname: string
      encoding: string
      mimetype: string
      size: number
      buffer: Buffer
      destination?: string
      filename?: string
      path?: string
    }
  }
}
