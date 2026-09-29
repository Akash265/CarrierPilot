export { createStorageClient } from "./client";
export { uploadResume, deleteResume, RESUME_BUCKET } from "./resumeStorage";
export {
  uploadGeneratedDocument, getGeneratedDocument, deleteGeneratedDocument, statGeneratedDocument, GENERATED_DOCUMENTS_BUCKET,
} from "./generatedDocumentStorage";
