server {
    listen {{listen}};
{{tlsLines}}
    server_name {{domain}};
    root {{docroot}};
    index index.php index.html;

    access_log {{accessLog}};
    error_log {{errorLog}};
    client_max_body_size 64m;

    location ~ /\.ht {
        deny all;
    }

    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \.php$ {
        try_files $uri =404;
        include fastcgi_params;
        fastcgi_pass unix:{{socket}};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param DOCUMENT_ROOT $document_root;
        fastcgi_param REMOTE_ADDR $remote_addr;
    }
}
