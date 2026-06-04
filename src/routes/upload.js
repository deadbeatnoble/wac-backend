import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, '../../uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|heic|heif|pdf)$/i;
const ALLOWED_MIME =
  /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf|application\/octet-stream)$/i;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const extOk = ALLOWED_EXT.test(ext);
    const mimeOk = !file.mimetype || ALLOWED_MIME.test(file.mimetype);
    if (extOk && mimeOk) {
      cb(null, true);
      return;
    }
    const err = new Error(
      'Only images (JPEG, PNG, GIF, WebP, HEIC) and PDF files are allowed'
    );
    err.statusCode = 400;
    cb(err);
  },
});

function multerSingle(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 5MB)' });
      }
      return res.status(err.statusCode || 400).json({
        error: err.message || 'Upload failed',
      });
    });
  };
}

const router = Router();

function handleUpload(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
}

router.post('/payment-proof', multerSingle('file'), handleUpload);
router.post('/banner', multerSingle('file'), handleUpload);

export default router;
