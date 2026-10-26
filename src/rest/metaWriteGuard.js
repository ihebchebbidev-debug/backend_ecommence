export const META_PRIVATE_KEYS = ['meta_pixel_id', 'meta_access_token'];
export function metaSettingWritable(row) {
  return !META_PRIVATE_KEYS.includes(row?.key);
}
export const metaWritePredicate = `"key" NOT IN ('meta_pixel_id','meta_access_token')`;