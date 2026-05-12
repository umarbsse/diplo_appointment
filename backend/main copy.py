import ddddocr
def solve_with_ddddocr(image_path):
    ocr = ddddocr.DdddOcr(show_ad=False)
    with open(image_path, 'rb') as f:
        img_bytes = f.read()
    
    # This library handles the denoising and OCR internally
    res = ocr.classification(img_bytes)
    return res

path = 'url-guard/background-image-1778612427159.jpg'
print(f"Decoded String: '{solve_with_ddddocr(path)}'")
