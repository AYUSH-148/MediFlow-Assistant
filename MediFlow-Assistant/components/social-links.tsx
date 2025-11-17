'use client'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGithub, faYoutube, faLinkedin } from '@fortawesome/free-brands-svg-icons';

const SocialMediaLinks = () => {
    return (
        <div className='flex flex-row gap-4'>
            <a href="https://github.com/AYUSH-148" target="_blank" rel="noopener noreferrer">
                <FontAwesomeIcon icon={faGithub} size="1x" />
            </a>
            <a href="https://www.linkedin.com/in/ayush-negi-300209257/" target="_blank" rel="noopener noreferrer">
                <FontAwesomeIcon icon={faLinkedin} size="1x" />
            </a>
        </div>
    );
};

export default SocialMediaLinks;