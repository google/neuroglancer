use std::ptr;
use std::alloc::{alloc, dealloc, Layout};
use std::slice;

use jxl_oxide::{FrameBuffer, JxlImage, PixelFormat};

#[no_mangle]
pub fn malloc(size: usize) -> *mut u8 {
    let layout = Layout::from_size_align(size, std::mem::align_of::<u8>()).unwrap();
    unsafe {
        let ptr = alloc(layout);
        if ptr.is_null() {
            panic!("Memory allocation failed");
        }
        ptr
    }
}

#[no_mangle]
pub fn free(ptr: *mut u8, size: usize) {
    let layout = Layout::from_size_align(size, std::mem::align_of::<u8>()).unwrap();
    unsafe {
        dealloc(ptr, layout);
    }
}

/// Returns width and height (no frame decode) packed into i64: bits 0..30 width, 31..61 height.
/// Error codes: -1 invalid args, -2 parse failure.
#[no_mangle]
pub fn height_and_width(ptr: *mut u8, input_size: usize) -> i64 {
    if ptr.is_null() || input_size == 0 {
        return -1;
    }

    let data: &[u8] = unsafe {
        slice::from_raw_parts(ptr, input_size)
    };

    match JxlImage::builder().read(data) {
        Ok(image) => (
            ((image.image_header().size.height as i64) << 31) | (((image.image_header().size.width as i64) & 0x7fffffff))
        ) as i64,
        Err(_) => -2,
    }
}

/// Combined metadata probe returning width, height, frame count in one call without decoding frames.
/// Encoded in i128: bits 0..30 width, 31..61 height, 62..92 frames. (All 31-bit slots.)
/// Returns negative on error (fits in i128). For JS FFI you may prefer a separate pointer-based variant.
#[no_mangle]
pub fn width_height_frames(ptr: *mut u8, input_size: usize) -> i128 {
    if ptr.is_null() || input_size == 0 { return -1; }
    let data: &[u8] = unsafe { slice::from_raw_parts(ptr, input_size) };
    let image = match JxlImage::builder().read(data) { Ok(img) => img, Err(_) => return -2 };
    let w = image.image_header().size.width as i128 & 0x7fffffff;
    let h = image.image_header().size.height as i128 & 0x7fffffff;
    let frames_loaded = image.num_loaded_keyframes() as i128; // may be 0 pre-render
    let f = if frames_loaded <= 0 { 1 } else { frames_loaded & 0x7fffffff };
    (f << 62) | (h << 31) | w
}

/// Combined metadata probe using an output buffer: writes [width, height, frames] as u32.
/// Returns 0 on success, negative error codes like width_height_frames.
#[no_mangle]
pub fn width_height_frames_out(ptr: *mut u8, input_size: usize, out: *mut u32) -> i32 {
    if ptr.is_null() || input_size == 0 || out.is_null() { return -1; }
    let data: &[u8] = unsafe { slice::from_raw_parts(ptr, input_size) };
    let image = match JxlImage::builder().read(data) { Ok(img) => img, Err(_) => return -2 };
    let w = image.image_header().size.width as u32;
    let h = image.image_header().size.height as u32;
    let loaded = image.num_loaded_keyframes() as u32;
    let f = if loaded == 0 { 1 } else { loaded };
    unsafe {
        *out.add(0) = w;
        *out.add(1) = h;
        *out.add(2) = f;
    }
    0
}

/// Returns number of keyframes (frames) in the codestream, or negative on error.
/// Attempts to return number of keyframes without fully decoding them.
/// Note: jxl_oxide lazily loads keyframes; if none are yet loaded this may return 1 as a heuristic.
/// Error codes: -1 invalid args, -2 header parse failure.
#[no_mangle]
pub fn frames(ptr: *mut u8, input_size: usize, _output_size: usize) -> i32 {
    if ptr.is_null() || input_size == 0 { return -1; }
    let data: &[u8] = unsafe { slice::from_raw_parts(ptr, input_size) };
    let image = match JxlImage::builder().read(data) { Ok(img) => img, Err(_) => return -2 };
    // We don't force rendering here; if no frames are "loaded" yet assume 1 (common case).
    let loaded = image.num_loaded_keyframes() as i32;
    if loaded <= 0 { 1 } else { loaded }
}


#[no_mangle]
pub fn decode(ptr: *mut u8, input_size: usize, output_size: usize) -> *const u8 {
    if ptr.is_null() || input_size == 0 || output_size == 0 {
        return ptr::null();
    }

    let data: &[u8] = unsafe {
        slice::from_raw_parts(ptr, input_size)
    };

    let image = match JxlImage::builder().read(data) {
        Ok(image) => image,
        Err(_image) => return std::ptr::null_mut(),
    };

    let mut output_buffer = Vec::with_capacity(output_size);

    for keyframe_idx in 0..image.num_loaded_keyframes() {
        let frame = match image.render_frame(keyframe_idx) {
            Ok(frame) => frame,
            Err(_frame) => return std::ptr::null_mut(),
        };

        let mut stream = frame.stream();
        let mut fb = FrameBuffer::new(
            stream.width() as usize,
            stream.height() as usize,
            stream.channels() as usize,
        );
        stream.write_to_buffer(fb.buf_mut());

        match image.pixel_format() {
            PixelFormat::Gray => {
                for pixel in fb.buf() {
                    let value = (pixel * 255.0).clamp(0.0, 255.0).round() as u8;
                    output_buffer.push(value);
                }
            },
            PixelFormat::Rgb => {
                for pixel in fb.buf() {
                    let value = (pixel * 255.0).clamp(0.0, 255.0).round() as u8;
                    output_buffer.push(value);
                }
            }
            PixelFormat::Rgba => {
                // fb.buf() laid out as RGBA RGBA ...; write exactly 4 bytes per pixel
                for px in fb.buf().chunks_exact(4) {
                    for c in 0..3 { // RGB
                        let v = (px[c] * 255.0).clamp(0.0, 255.0) as u8;
                        output_buffer.push(v);
                    }
                    output_buffer.push(255); // opaque alpha
                }
            }
            _ => return std::ptr::null_mut(),
        }
    }

    // Allocate memory in WASM and return a pointer and length
    let ptr = output_buffer.as_ptr();

    // Ensure that the memory is not dropped until after we return
    std::mem::forget(output_buffer);

    ptr
}

/// Extended decode that supports 1-, 2-, or 4-byte per sample output.
/// 1 => uint8, 2 => uint16 little-endian, 4 => float32 little-endian (linear 0..1).
/// Returns a pointer to a heap-allocated buffer of length exactly `output_size` on success or null on failure.
#[no_mangle]
pub fn decode_with_bpp(ptr: *mut u8, input_size: usize, output_size: usize, bytes_per_sample: usize) -> *const u8 {
    if ptr.is_null() || input_size == 0 || output_size == 0 {
        return ptr::null();
    }

    if bytes_per_sample != 1 && bytes_per_sample != 2 && bytes_per_sample != 4 {
        return ptr::null();
    }

    let data: &[u8] = unsafe { slice::from_raw_parts(ptr, input_size) };

    let image = match JxlImage::builder().read(data) {
        Ok(image) => image,
        Err(_image) => return std::ptr::null_mut(),
    };

    let mut output_buffer: Vec<u8> = Vec::with_capacity(output_size);

    for keyframe_idx in 0..image.num_loaded_keyframes() {
        let frame = match image.render_frame(keyframe_idx) {
            Ok(frame) => frame,
            Err(_frame) => return std::ptr::null_mut(),
        };

        let mut stream = frame.stream();
        let mut fb = FrameBuffer::new(
            stream.width() as usize,
            stream.height() as usize,
            stream.channels() as usize,
        );
        stream.write_to_buffer(fb.buf_mut());

        match image.pixel_format() {
            PixelFormat::Gray => {
                for pixel in fb.buf() { // pixel in 0.0..1.0
                    match bytes_per_sample {
                        1 => {
                            let value = (pixel * 255.0).clamp(0.0, 255.0) as u8;
                            output_buffer.push(value);
                        }
                        2 => {
                            let v = (pixel * 65535.0).clamp(0.0, 65535.0).round() as u16;
                            output_buffer.extend_from_slice(&v.to_le_bytes());
                        }
                        4 => {
                            let f = *pixel as f32; // already 0..1 linear
                            output_buffer.extend_from_slice(&f.to_le_bytes());
                        }
                        _ => return ptr::null_mut(),
                    }
                }
            },
            PixelFormat::Rgb => {
                for pixel in fb.buf() {
                    match bytes_per_sample {
                        1 => {
                            let value = (pixel * 255.0).clamp(0.0, 255.0) as u8;
                            output_buffer.push(value);
                        }
                        2 => {
                            let v = (pixel * 65535.0).clamp(0.0, 65535.0).round() as u16;
                            output_buffer.extend_from_slice(&v.to_le_bytes());
                        }
                        4 => {
                            let f = *pixel as f32;
                            output_buffer.extend_from_slice(&f.to_le_bytes());
                        }
                        _ => return ptr::null_mut(),
                    }
                }
            }
            PixelFormat::Rgba => {
                // Iterate per pixel (4 floats)
                for px in fb.buf().chunks_exact(4) {
                    match bytes_per_sample {
                        1 => {
                            for c in 0..3 { // RGB
                                let v = (px[c] * 255.0).clamp(0.0, 255.0) as u8; output_buffer.push(v);
                            }
                            output_buffer.push(255); // alpha
                        }
                        2 => {
                            for c in 0..3 {
                                let v = (px[c] * 65535.0).clamp(0.0, 65535.0).round() as u16;
                                output_buffer.extend_from_slice(&v.to_le_bytes());
                            }
                            output_buffer.extend_from_slice(&0xFFFFu16.to_le_bytes());
                        }
                        4 => {
                            for c in 0..3 {
                                let f = px[c] as f32; output_buffer.extend_from_slice(&f.to_le_bytes());
                            }
                            let alpha: f32 = 1.0; output_buffer.extend_from_slice(&alpha.to_le_bytes());
                        }
                        _ => return ptr::null_mut(),
                    }
                }
            }
            _ => return std::ptr::null_mut(),
        }
    }

    if output_buffer.len() != output_size {
        // Size mismatch -> unsafe to expose.
        return std::ptr::null_mut();
    }

    let ptr_out = output_buffer.as_ptr();
    std::mem::forget(output_buffer);
    ptr_out
}


