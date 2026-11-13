use crate::Engine;
use std::cell::RefCell;

#[derive(Default)]
struct Instance {
    engine: Engine,
    input: Vec<u8>,
    output: Vec<u8>,
}
thread_local! { static INSTANCE: RefCell<Instance> = RefCell::new(Instance::default()); }
#[unsafe(no_mangle)]
pub extern "C" fn modelt_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn modelt_input_resize(length: u32) -> *mut u8 {
    INSTANCE.with_borrow_mut(|instance| {
        instance.input.resize(length as usize, 0);
        instance.input.as_mut_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn modelt_dispatch() {
    INSTANCE.with_borrow_mut(|instance| {
        let message = instance.engine.dispatch(&instance.input);
        instance.output = serde_json::to_vec(&message).expect("serializable core message");
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn modelt_output_ptr() -> *const u8 {
    INSTANCE.with_borrow(|instance| instance.output.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn modelt_output_len() -> u32 {
    INSTANCE.with_borrow(|instance| instance.output.len() as u32)
}
