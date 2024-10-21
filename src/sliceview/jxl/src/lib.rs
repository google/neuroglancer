use std::ptr;
use std::alloc::{alloc, dealloc, Layout};
use std::slice;

use jxl_oxide::{JxlImage, PixelFormat};

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
pub fn decode(ptr: *mut u8, size: usize) -> *const u8 {
    if ptr.is_null() || size == 0 {
        return ptr::null();
    }

    let data: &[u8] = unsafe {
        slice::from_raw_parts(ptr, size)
    };

    let image = match JxlImage::from_reader(data) {
        Ok(image) => image,
        Err(_image) => return std::ptr::null_mut(),
    };

    let mut output_buffer = Vec::new();

    for keyframe_idx in 0..image.num_loaded_keyframes() {
        let frame = match image.render_frame(keyframe_idx) {
            Ok(frame) => frame,
            Err(_frame) => return std::ptr::null_mut(),
        };

        let fb = frame.image();
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
                for pixel in fb.buf() {
                    let value = (pixel * 255.0).clamp(0.0, 255.0) as u8;
                    output_buffer.push(value);
                    output_buffer.push(255);  // Alpha channel set to fully opaque
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


