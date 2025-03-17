Collecting workspace informationHere's a README.md for setting up the Myntra scraper project on Windows:

```markdown
# Myntra Product Scraper

A web application that scrapes product information from Myntra, Amazon, and Flipkart. Built with Node.js, Express, and Puppeteer.

## Features

- Scrape individual product details from Myntra, Amazon, and Flipkart
- Bulk import products via CSV upload
- Price history tracking
- Cross-platform price comparison
- Export product data to CSV
- Interactive web interface

## Prerequisites

- Node.js 14+ installed on your system
- Git (optional)
- Windows 10 or later

## Installation

1. Clone the repository or download the source code:
```bash
git clone https://github.com/harshitIIITD/myntra-scraper.git
cd myntra-scraper
```

2. Install dependencies:
```bash
npm install
```

3. Create required directories:
```bash
mkdir cache
mkdir price-history
mkdir uploads

mkdir user-state
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to:
```
http://localhost:3001
```

## Using the Web Interface

### Single Product Scraping
1. Enter a product URL from Myntra, Amazon, or Flipkart
2. Select the appropriate website from the dropdown
3. Click "Scrape Product"

### Bulk Import via CSV
1. Create a CSV file with product IDs:
```csv
style_id,name
2127876,Product Name
```
2. Upload the CSV file using the "CSV Upload" tab
3. Select the website and click "Upload and Scrape"

### Downloading Results
- Click "Download Products CSV" to export all scraped products

## Project Structure

```
myntra-scraper/
├── cache/              # Cached product data
├── price-history/      # Price history data
├── public/             # Web interface files
├── uploads/           # Temporary CSV uploads
├── user-state/        # User preferences
├── scraper.js         # Scraping logic
├── server.js          # Express server
└── package.json       # Project dependencies
```

## Error Handling

- The scraper includes retry logic for failed requests
- Timeouts are set to 60 seconds per product
- Failed scrapes are logged and reported in the UI

## Common Issues

1. **ECONNREFUSED errors**
   - Check your internet connection
   - Verify the website is accessible
   - Try using a VPN if the site is blocking your IP

2. **Memory issues**
   - Reduce concurrent scraping limit in server.js
   - Clear the cache directory
   - Restart the server

3. **Missing Directories**
   - Ensure all required directories are created
   - Check directory permissions

## Rate Limiting

The scraper includes built-in rate limiting:
- 5 concurrent requests maximum
- 200ms delay between requests
- Automatic request queuing

## License

ISC License

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request
