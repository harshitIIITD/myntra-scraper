const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Create a function to make HTTP requests with proper headers to avoid detection
function makeRequest(url) {
  return new Promise((resolve, reject) => {
    // Parse URL to determine if it's HTTP or HTTPS
    const isHttps = url.startsWith('https://');
    const client = isHttps ? https : http;
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    };
    
    console.log(`Making HTTP request to: ${url}`);
    
    const req = client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirects
        console.log(`Following redirect to: ${res.headers.location}`);
        makeRequest(res.headers.location).then(resolve).catch(reject);
        return;
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP status code: ${res.statusCode}`));
        return;
      }
      
      // Collect data
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    
    req.on('error', reject);
    req.end();
  });
}

// Function to extract product data using regex patterns
function extractProductData(html, url) {
  console.log('Extracting product data using regex patterns');
  
  // Default data structure
  const data = {
    title: 'Unknown Product',
    brand: 'Unknown Brand',
    price: 'N/A',
    description: '',
    images: [],
    availability: 'in_stock'
  };
  
  try {
    // Extract title
    const titleMatch = html.match(/<h1[^>]*class="[^"]*pdp-name[^"]*"[^>]*>(.*?)<\/h1>/i) || 
                      html.match(/<h1[^>]*class="[^"]*pdp-title[^"]*"[^>]*>(.*?)<\/h1>/i) ||
                      html.match(/<title>(.*?)(?:\s*\|\s*Myntra)?<\/title>/i);
    
    if (titleMatch && titleMatch[1]) {
      data.title = titleMatch[1].trim();
    }
    
    // Extract brand
    const brandMatch = html.match(/<h1[^>]*class="[^"]*pdp-title[^"]*"[^>]*>(.*?)<\/h1>/i) ||
                      html.match(/<div[^>]*class="[^"]*brand-name[^"]*"[^>]*>(.*?)<\/div>/i);
    
    if (brandMatch && brandMatch[1]) {
      data.brand = brandMatch[1].trim();
    }
    
    // Extract price
    const priceMatch = html.match(/<span[^>]*class="[^"]*pdp-price[^"]*"[^>]*>Rs\.\s*([0-9,]+)<\/span>/i) ||
                      html.match(/class="[^"]*pdp-price[^"]*"[^>]*>([^<]*)</i);
    
    if (priceMatch && priceMatch[1]) {
      data.price = priceMatch[1].trim().replace(/[^\d]/g, '');
    }
    
    // Check availability
    const outOfStock = html.includes('OUT OF STOCK') || html.includes('out of stock') || html.includes('sold out');
    data.availability = outOfStock ? 'out_of_stock' : 'in_stock';
    
    // Extract product ID
    const productId = url.split('/').pop().replace(/\D/g, '');
    data.id = productId;
    
    return {
      success: true,
      data: {
        data: data
      }
    };
  } catch (error) {
    console.error('Error extracting data with regex:', error);
    return {
      success: false,
      error: 'Failed to extract product data',
      details: error.message
    };
  }
}

// Main scraper function using HTTP approach instead of Puppeteer
async function scrapeWithHttp(url) {
  console.log(`Starting HTTP scraper fallback for: ${url}`);
  
  try {
    // Get the HTML
    const html = await makeRequest(url);
    
    // Extract the product data
    const result = extractProductData(html, url);
    
    // Extract product ID from URL
    const urlSegments = url.split('/');
    const productId = urlSegments[urlSegments.length - 1].replace(/\D/g, '');
    
    // Save result to cache
    if (result.success) {
      const cacheDir = path.join(__dirname, 'cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir);
      }
      
      fs.writeFileSync(
        path.join(cacheDir, `${productId}.json`),
        JSON.stringify({timestamp: Date.now(), data: result})
      );
    }
    
    return result;
  } catch (error) {
    console.error('HTTP scraper error:', error);
    return {
      success: false,
      error: 'HTTP scraper failed',
      details: error.message
    };
  }
}

module.exports = { scrapeWithHttp };