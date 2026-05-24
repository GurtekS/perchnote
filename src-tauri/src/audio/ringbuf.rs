use ringbuf::{HeapRb, traits::*};

pub type AudioProducer = ringbuf::HeapProd<f32>;
pub type AudioConsumer = ringbuf::HeapCons<f32>;

pub fn create_audio_ring(capacity: usize) -> (AudioProducer, AudioConsumer) {
    let rb = HeapRb::<f32>::new(capacity);
    rb.split()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::traits::{Producer, Consumer};

    #[test]
    fn test_create_ring_buffer_with_capacity() {
        let (mut prod, mut cons) = create_audio_ring(1024);
        assert_eq!(prod.vacant_len(), 1024);
        assert_eq!(cons.occupied_len(), 0);
    }

    #[test]
    fn test_push_and_pop_samples() {
        let (mut prod, mut cons) = create_audio_ring(8);
        let samples = [0.1f32, 0.2, 0.3, 0.4];
        let written = prod.push_slice(&samples);
        assert_eq!(written, 4);

        let mut out = [0.0f32; 4];
        let read = cons.pop_slice(&mut out);
        assert_eq!(read, 4);
        assert!((out[0] - 0.1).abs() < f32::EPSILON);
        assert!((out[1] - 0.2).abs() < f32::EPSILON);
        assert!((out[2] - 0.3).abs() < f32::EPSILON);
        assert!((out[3] - 0.4).abs() < f32::EPSILON);
    }

    #[test]
    fn test_consumer_empty_when_nothing_pushed() {
        let (_prod, mut cons) = create_audio_ring(16);
        let mut out = [0.0f32; 4];
        let read = cons.pop_slice(&mut out);
        assert_eq!(read, 0);
    }

    #[test]
    fn test_buffer_full_producer_cannot_push_more() {
        let (mut prod, _cons) = create_audio_ring(4);
        let data = [1.0f32; 6]; // More than capacity
        let written = prod.push_slice(&data);
        assert_eq!(written, 4, "should only write up to capacity");
    }

    #[test]
    fn test_push_pop_preserves_order() {
        let (mut prod, mut cons) = create_audio_ring(16);
        let samples: Vec<f32> = (0..10).map(|i| i as f32 * 0.1).collect();
        prod.push_slice(&samples);

        let mut out = vec![0.0f32; 10];
        cons.pop_slice(&mut out);

        for (i, &val) in out.iter().enumerate() {
            assert!((val - samples[i]).abs() < f32::EPSILON, "order must be preserved at index {i}");
        }
    }

    #[test]
    fn test_partial_read_leaves_remainder() {
        let (mut prod, mut cons) = create_audio_ring(16);
        prod.push_slice(&[1.0f32, 2.0, 3.0, 4.0]);

        let mut out = [0.0f32; 2];
        let read = cons.pop_slice(&mut out);
        assert_eq!(read, 2);
        assert_eq!(cons.occupied_len(), 2, "2 samples should remain in buffer");
    }
}
