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

    let mut image = match JxlImage::from_reader(data) {
        Ok(image) => image,
        Err(_image) => return std::ptr::null_mut(),
    };

    let mut output_buffer = Vec::new();
    let mut renderer = image.renderer();

    loop {
        let result = match renderer.render_next_frame() {
            Ok(result) => result,
            Err(_result) => return std::ptr::null_mut(),
        };
        match result {
            jxl_oxide::RenderResult::Done(frame) => {
                let fb = frame.image();
                match renderer.pixel_format() {
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
            jxl_oxide::RenderResult::NeedMoreData => return std::ptr::null_mut(),
            jxl_oxide::RenderResult::NoMoreFrames => break,
        }
    }

    // Allocate memory in WASM and return a pointer and length
    let ptr = output_buffer.as_ptr();

    // Ensure that the memory is not dropped until after we return
    std::mem::forget(output_buffer);

    ptr
}


