/**
 * How hard a picture is shrunk before it is uploaded — a module with NO
 * imports, so a server component can name a grade without pulling the
 * browser's compressor into its bundle (`compress-photo.ts` imports
 * `browser-image-compression`).
 *
 * A photographed DOCUMENT is read by people and by the model afterwards: the
 * warehouse screens' 0.3 MB / 1600 px (the carton photo's size) crushes the
 * small print of a table, so a paper keeps more of itself. The lot tarkibi
 * editor's upload, and the prixod card's for a reader whose pictures the
 * server stores as papers (docs/PRIXOD-JAVOBLAR.md §3.3).
 */
export const DOCUMENT_PHOTO = { maxSizeMB: 1, maxWidthOrHeight: 2000 } as const;
