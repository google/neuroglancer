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

#[no_mangle]
pub fn width(ptr: *mut u8, input_size: usize, output_size: usize) -> i32 {
    if ptr.is_null() || input_size == 0 || output_size == 0 {
        return -1;
    }

    let data: &[u8] = unsafe {
        slice::from_raw_parts(ptr, input_size)
    };

    let image = match JxlImage::builder().read(data) {
        Ok(image) => image,
        Err(_image) => return -2,
    };

    for keyframe_idx in 0..image.num_loaded_keyframes() {
        let frame = match image.render_frame(keyframe_idx) {
            Ok(frame) => frame,
            Err(_frame) => return -3,
        };

        let stream = frame.stream();
        return stream.width() as i32;
    }

    -4 as i32
}

#[no_mangle]
pub fn height(ptr: *mut u8, input_size: usize, output_size: usize) -> i32 {
    if ptr.is_null() || input_size == 0 || output_size == 0 {
        return -1;
    }

    let data: &[u8] = unsafe {
        slice::from_raw_parts(ptr, input_size)
    };

    let image = match JxlImage::builder().read(data) {
        Ok(image) => image,
        Err(_image) => return -2,
    };

    for keyframe_idx in 0..image.num_loaded_keyframes() {
        let frame = match image.render_frame(keyframe_idx) {
            Ok(frame) => frame,
            Err(_frame) => return -3,
        };

        let stream = frame.stream();
        return stream.height() as i32;
    }

    -4 as i32
}

/// Returns number of keyframes (frames) in the codestream, or negative on error.
#[no_mangle]
pub fn frames(ptr: *mut u8, input_size: usize, output_size: usize) -> i32 {
    if ptr.is_null() || input_size == 0 || output_size == 0 { return -1; }
    let data: &[u8] = unsafe { slice::from_raw_parts(ptr, input_size) };
    let image = match JxlImage::builder().read(data) { Ok(image) => image, Err(_image) => return -2 };
    let mut count = 0i32;
    for keyframe_idx in 0..image.num_loaded_keyframes() {
        let _ = match image.render_frame(keyframe_idx) { Ok(frame) => frame, Err(_frame) => return -3 };
        count += 1;
    }
    if count == 0 { -4 } else { count }
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
                    let value = (pixel * 255.0).clamp(0.0, 255.0) as u8;
                    output_buffer.push(value);
                }
            },
            PixelFormat::Rgb => {
                for pixel in fb.buf() {
                    let value = (pixel * 255.0).clamp(0.0, 255.0) as u8;
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


