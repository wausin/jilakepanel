server {
    listen {{listen}};
{{tlsLines}}
    server_name {{domain}};
    root {{docroot}};
    index index.html;

    access_log {{accessLog}};
    error_log {{errorLog}};
    client_max_body_size 64m;

    location ~ /\.ht {
        deny all;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
